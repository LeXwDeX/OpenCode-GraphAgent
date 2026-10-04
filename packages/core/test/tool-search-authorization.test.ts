import fs from "fs/promises"
import path from "path"
import os from "os"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { GlobTool } from "@opencode-ai/core/tool/glob"
import { GrepTool } from "@opencode-ai/core/tool/grep"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { location } from "./fixture/location"
import { executeTool, toolIdentity } from "./lib/tool"

for (const name of ["glob", "grep"] as const) {
  describe(`${name} search directory authorization`, () => {
    for (const scenario of [
      "internal",
      "denied",
      "approved",
      "relative escape",
      "symlink escape",
      "external file",
    ] as const) {
      if (name === "glob" && scenario === "external file") continue
      test(scenario, async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-search-auth-"))
        try {
          const directory = path.join(root, "location")
          const external = path.join(root, "external")
          await fs.mkdir(directory)
          await fs.mkdir(external)
          await fs.writeFile(path.join(external, "retained.txt"), "search")
          await fs.symlink(external, path.join(directory, "escape"), "junction")
          const assertions: PermissionV2.AssertInput[] = []
          const calls: (Ripgrep.GlobInput | Ripgrep.GrepInput)[] = []
          const permission = Layer.mock(PermissionV2.Service, {
            assert: (input) =>
              Effect.suspend(() => {
                assertions.push(input)
                return scenario === "denied" && input.action === "external_directory"
                  ? Effect.fail(new PermissionV2.DeniedError({ rules: [] }))
                  : Effect.void
              }),
          })
          const infrastructure = Layer.mergeAll(
            FSUtil.defaultLayer,
            permission,
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
            Layer.mock(Ripgrep.Service, {
              glob: (input) =>
                Effect.sync(() => {
                  calls.push(input)
                  return []
                }),
              grep: (input) =>
                Effect.sync(() => {
                  calls.push(input)
                  return []
                }),
            }),
          )
          const mutation = LocationMutation.layer.pipe(Layer.provide(infrastructure))
          const registry = ToolRegistry.defaultLayer
          const leaf = (name === "glob" ? GlobTool.layer : GrepTool.layer).pipe(
            Layer.provide(registry),
            Layer.provide(mutation),
            Layer.provide(infrastructure),
          )
          const target =
            scenario === "internal"
              ? "."
              : scenario === "relative escape"
                ? "../external"
                : scenario === "symlink escape"
                  ? "escape"
                  : scenario === "external file"
                    ? path.join(external, "retained.txt")
                    : external
          const result = await Effect.gen(function* () {
            return yield* executeTool(yield* ToolRegistry.Service, {
              sessionID: SessionV2.ID.make("ses_search_authorization"),
              ...toolIdentity,
              call: { type: "tool-call", id: "call-search", name, input: { pattern: "search", path: target } },
            })
          }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(registry, leaf)), Effect.runPromise)
          const blocked = ["denied", "relative escape", "symlink escape"].includes(scenario)
          expect(result.type).toBe(blocked ? "error" : "text")
          expect(calls).toHaveLength(blocked ? 0 : 1)
          expect(assertions.map((x) => x.action)).toEqual(
            scenario === "internal"
              ? [name]
              : ["relative escape", "symlink escape"].includes(scenario)
                ? []
                : scenario === "denied"
                  ? ["external_directory"]
                  : ["external_directory", name],
          )
          if (assertions[0]?.action === "external_directory") {
            expect(assertions[0].resources).toEqual([path.join(await fs.realpath(external), "*").replaceAll("\\", "/")])
          }
          if (!blocked) {
            expect(calls[0]?.cwd).toBe(await fs.realpath(scenario === "internal" ? directory : external))
            if (scenario === "external file") expect(calls[0]).toMatchObject({ file: "retained.txt" })
          }
        } finally {
          await fs.rm(root, { recursive: true, force: true })
        }
      })
    }
  })
}
