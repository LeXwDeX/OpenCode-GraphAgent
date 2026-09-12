// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- narrow session and agent fixtures
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Fiber, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Project } from "@opencode-ai/core/project"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { commitOutputFileRef } from "@/dag/runtime/output-ref"
import { artifactReadPermissions, makeArtifactSourceAuthorizer } from "@/dag/runtime/artifact-permissions"
import { it, pollWithTimeout } from "../lib/effect"

const provenance = {
  workflow_id: "artifact-auth",
  node_id: "producer",
  child_session_id: "ses_producer",
  replan_attempt: 0,
}

test.skipIf(process.platform !== "win32")(
  "keeps canonical source deny and managed edit deny after the entire aliased worktree is deleted",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dag-alias-permission-"))
    let objectDirectory: string | undefined
    try {
      const directory = path.join(root, "original")
      const alias = path.join(root, "alias")
      await fs.mkdir(directory)
      await fs.symlink(directory, alias, "junction")
      const source = path.join(alias, "secret.txt")
      await fs.writeFile(source, `alias report ${root}`)
      const canonicalSource = FSUtil.normalizePath(source)
      expect(canonicalSource).not.toBe(source)
      const rules = Permission.fromConfig({
        read: { [path.relative(process.cwd(), canonicalSource)]: "allow" },
        external_directory: { [FSUtil.normalizePathPattern(path.join(directory, "*"))]: "allow" },
      })
      const authorize = makeArtifactSourceAuthorizer(
        { get: () => Effect.succeed({ agent: "build", permission: rules } as never) } as never,
        { get: () => Effect.succeed({ permission: [] } as never) } as never,
        process.cwd(),
      )
      const checked: string[] = []
      const ref = await Effect.runPromise(
        commitOutputFileRef(source, provenance, (value) => {
          checked.push(value)
          return authorize("ses_producer", value)
        }),
      )
      expect(ref).toBeDefined()
      if (!ref) throw new Error("missing committed report")
      expect(checked).toEqual([canonicalSource])
      expect(ref.source_path).toBe(canonicalSource)
      objectDirectory = path.dirname(ref.path)
      const targetPattern = path.relative(process.cwd(), FSUtil.normalizePath(ref.path))
      await fs.rm(root, { recursive: true, force: true })
      await Effect.runPromise(authorize("ses_producer", ref.source_path))
      expect(
        await fs.stat(root).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      const inherited = Permission.fromConfig({
        read: { "*": "allow", [path.relative(process.cwd(), canonicalSource)]: "deny" },
      })
      const grants = artifactReadPermissions([ref], process.cwd(), inherited)
      // ReadTool evaluates the canonical file path, even when submitted with a
      // different Windows spelling; source restrictions must follow that path.
      expect(Permission.evaluate("read", targetPattern, inherited, grants).action).toBe("deny")
      expect(Permission.evaluate("edit", targetPattern, grants).action).toBe("deny")
      expect(await fs.readFile(ref.path, "utf8")).toBe(`alias report ${root}`)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      if (objectDirectory) await fs.rm(objectDirectory, { recursive: true, force: true })
    }
  },
)

for (const permission of ["read", "external_directory"] as const) {
  for (const decision of ["deny", "once", "always", "reject"] as const) {
    it.live(`capture checks ${permission} before reading bytes (${decision})`, () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dag-authorize-"))),
          (value) => Effect.promise(() => fs.rm(value, { recursive: true, force: true })),
        )
        const source = path.join(directory, "secret.txt")
        const body = `private body ${directory}`
        const digest = createHash("sha256").update(body).digest("hex")
        const target = path.join(
          Global.Path.data,
          "workflow-artifacts",
          "objects",
          digest.slice(0, 2),
          digest,
          "content.txt",
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => fs.rm(path.dirname(target), { recursive: true, force: true })),
        )
        yield* Effect.promise(() => fs.writeFile(source, body))
        const pattern =
          permission === "read"
            ? path.relative(process.cwd(), FSUtil.normalizePath(source))
            : FSUtil.normalizePathPattern(path.join(directory, "*"))
        const sessionRules = [{ permission, pattern, action: decision === "deny" ? "deny" : "ask" }] as const
        const program = Effect.gen(function* () {
          const sessions = yield* Session.Service
          const agents = yield* Agent.Service
          const permissions = yield* Permission.Service
          const authorize = makeArtifactSourceAuthorizer(sessions, agents, process.cwd(), permissions)
          const capture = commitOutputFileRef(source, provenance, (value) => authorize("ses_producer", value))
          if (decision === "deny") {
            expect(yield* capture.pipe(Effect.flip)).toBeInstanceOf(Error)
            expect(yield* permissions.list()).toHaveLength(0)
            expect(
              yield* Effect.promise(() =>
                fs.stat(target).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false)
            return
          }
          const fiber = yield* capture.pipe(Effect.forkScoped)
          const requests = yield* pollWithTimeout(
            permissions.list().pipe(Effect.map((items) => (items.length ? items : undefined))),
            "capture did not request approval",
          )
          expect(requests[0].permission).toBe(permission)
          expect(requests[0].patterns).toEqual([pattern])
          expect(
            yield* Effect.promise(() =>
              fs.stat(target).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
          yield* permissions.reply({ requestID: requests[0].id, reply: decision })
          if (decision === "reject") {
            expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBeInstanceOf(Error)
            expect(
              yield* Effect.promise(() =>
                fs.stat(target).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false)
            return
          }
          const ref = yield* Fiber.join(fiber)
          expect(ref?.summary).toBe(body)
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(body)
          if (decision === "always") {
            yield* capture
            expect(yield* permissions.list()).toHaveLength(0)
          }
        })
        yield* program.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Session.Service, {
                get: () => Effect.succeed({ agent: "build", permission: sessionRules } as never),
              }),
              Layer.mock(Agent.Service, {
                get: () =>
                  Effect.succeed({ permission: [{ permission: "*", pattern: "*", action: "allow" }] } as never),
              }),
              Permission.layer.pipe(
                Layer.provide(Layer.mock(EventV2Bridge.Service, { publish: () => Effect.succeed({} as never) })),
              ),
            ),
          ),
          Effect.provideService(InstanceRef, {
            directory,
            worktree: process.cwd(),
            project: { id: Project.ID.global },
          } as never),
        )
      }).pipe(Effect.scoped),
    )
  }
}
