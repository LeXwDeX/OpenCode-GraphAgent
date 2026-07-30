import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { PluginSdk } from "@opencode-ai/core/plugin-sdk"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { tmpdir } from "./fixture/tmpdir"

const win = process.platform === "win32"

const writePackage = (dir: string, pkg: Record<string, unknown>) =>
  Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      version: "1.0.0",
      ...pkg,
    }),
  )

const npmLayer = (cache: string) =>
  Npm.layer.pipe(
    Layer.provide(EffectFlock.layer),
    Layer.provide(FSUtil.layer),
    Layer.provide(Global.layerWith({ cache, state: path.join(cache, "state") })),
    Layer.provide(NodeFileSystem.layer),
  )

describe("Npm.sanitize", () => {
  test("keeps normal scoped package specs unchanged", () => {
    expect(Npm.sanitize("@opencode/acme")).toBe("@opencode/acme")
    expect(Npm.sanitize("@opencode/acme@1.0.0")).toBe("@opencode/acme@1.0.0")
    expect(Npm.sanitize("prettier")).toBe("prettier")
  })

  test("handles git https specs", () => {
    const spec = "acme@git+https://github.com/opencode/acme.git"
    const expected = win ? "acme@git+https_//github.com/opencode/acme.git" : spec
    expect(Npm.sanitize(spec)).toBe(expected)
  })
})

describe("Npm.add", () => {
  test("reifies when package cache directory exists without the package installed", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "fixture-provider"))
    await writePackage(path.join(tmp.path, "fixture-provider"), {
      name: "fixture-provider",
      main: "index.js",
    })
    await Bun.write(path.join(tmp.path, "fixture-provider", "index.js"), "export const fixture = true\n")

    const spec = `fixture-provider@file:${path.join(tmp.path, "fixture-provider")}`
    await fs.mkdir(path.join(tmp.path, "cache", "packages", Npm.sanitize(spec)), { recursive: true })

    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(spec)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

    expect(entry.entrypoint).toBeDefined()
  })
})

describe("Npm.install", () => {
  test("respects omit from project .npmrc", async () => {
    await using tmp = await tmpdir()

    await writePackage(tmp.path, {
      name: "fixture",
      dependencies: {
        "prod-pkg": "file:./prod-pkg",
      },
      devDependencies: {
        "dev-pkg": "file:./dev-pkg",
      },
    })
    await Bun.write(path.join(tmp.path, ".npmrc"), "omit=dev\n")
    await fs.mkdir(path.join(tmp.path, "prod-pkg"))
    await fs.mkdir(path.join(tmp.path, "dev-pkg"))
    await writePackage(path.join(tmp.path, "prod-pkg"), { name: "prod-pkg" })
    await writePackage(path.join(tmp.path, "dev-pkg"), { name: "dev-pkg" })

    await Npm.install(tmp.path)

    await expect(fs.stat(path.join(tmp.path, "node_modules", "prod-pkg"))).resolves.toBeDefined()
    await expect(fs.stat(path.join(tmp.path, "node_modules", "dev-pkg"))).rejects.toThrow()
  })

  test("skips registry when plugin dependency already exists locally", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "node_modules", "@opencode-ai", "plugin"), { recursive: true })
    await writePackage(path.join(tmp.path, "node_modules", "@opencode-ai", "plugin"), { name: "@opencode-ai/plugin" })

    await Effect.gen(function* () {
      const npm = yield* Npm.Service
      yield* npm.install(tmp.path, { add: [{ name: "@opencode-ai/plugin", version: "1.17.11-main.3" }] })
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

    await expect(fs.stat(path.join(tmp.path, "package-lock.json"))).rejects.toThrow()
  })

  test("copies bundled plugin dependency before registry fallback", async () => {
    await using tmp = await tmpdir()
    const bundled = path.join(tmp.path, "bundled-plugin-sdk")
    process.env.OPENCODE_PLUGIN_SDK_PATH = bundled
    await fs.mkdir(path.join(bundled, "src"), { recursive: true })
    await writePackage(bundled, { name: "@opencode-ai/plugin", exports: { ".": "./src/index.ts", "./tui": "./src/tui.ts" } })
    await Bun.write(path.join(bundled, "src", "index.ts"), "export const plugin = true\n")
    await Bun.write(path.join(bundled, "src", "tui.ts"), "export const tui = true\n")

    try {
      await Effect.gen(function* () {
        const npm = yield* Npm.Service
        yield* npm.install(tmp.path, { add: [{ name: "@opencode-ai/plugin" }] })
      }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

      await expect(fs.stat(path.join(tmp.path, "node_modules", "@opencode-ai", "plugin", "src", "tui.ts"))).resolves.toBeDefined()
      await expect(fs.stat(path.join(tmp.path, "package-lock.json"))).rejects.toThrow()
    } finally {
      delete process.env.OPENCODE_PLUGIN_SDK_PATH
    }
  })
})
