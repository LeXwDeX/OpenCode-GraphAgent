import { expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PluginSdk } from "@opencode-ai/core/plugin-sdk"
import { CurrentWorkingDirectory } from "@/config/tui-cwd"
import { TuiConfig } from "../../src/config/tui"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer))

const withEnv = <A, E, R>(name: string, value: string | undefined, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }),
  )

// Seeds the on-disk steady state of a config directory after a first successful
// startup: package.json declaring the plugin sdk, node_modules populated from a
// local copy, and a tui.json whose path plugin keeps dependency installs armed.
const seedConfigDir = async (dir: string) => {
  const localPlugin = path.join(dir, "local-plugin")
  await fs.mkdir(localPlugin, { recursive: true })
  await Bun.write(
    path.join(localPlugin, "package.json"),
    JSON.stringify({ name: PluginSdk.packageName, version: "1.0.0", main: "index.js" }),
  )
  await Bun.write(path.join(localPlugin, "index.js"), "export const plugin = true\n")

  await Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "tui-deps-fixture",
      version: "1.0.0",
      dependencies: { [PluginSdk.packageName]: "file:./local-plugin" },
    }),
  )
  await fs.cp(localPlugin, path.join(dir, "node_modules", ...PluginSdk.packageName.split("/")), { recursive: true })

  await Bun.write(path.join(dir, "test-plugin.ts"), "export const fixture_plugin = true\n")
  await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ plugin: ["./test-plugin.ts"] }))
}

const lockSnapshot = async (lockPath: string) => {
  const [bytes, stat] = await Promise.all([fs.readFile(lockPath), fs.stat(lockPath)])
  return { bytes: bytes.toString(), ino: stat.ino, mtimeMs: stat.mtimeMs }
}

// One full TUI/config dependency initialization: a fresh TuiConfig layer build
// (the startup path that forks npm.install for the config dir) followed by
// waiting for the forked installs to settle.
const startup = (directory: string, configDir: string) =>
  withEnv(
    "OPENCODE_CONFIG_DIR",
    configDir,
    TuiConfig.Service.use((svc) => svc.waitForDependencies()).pipe(
      Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory)))),
    ),
  )

it.instance("keeps the config package-lock stable across two dependency initializations", () =>
  withEnv(
    "npm_config_audit",
    "false",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const configDir = path.join(test.directory, "deps-config")
      yield* Effect.promise(() => fs.mkdir(configDir, { recursive: true }))
      yield* Effect.promise(() => seedConfigDir(configDir))

      const lockPath = path.join(configDir, "package-lock.json")

      yield* startup(test.directory, configDir)
      const afterFirst = yield* Effect.promise(() => lockSnapshot(lockPath))
      const lock = JSON.parse(yield* Effect.promise(() => fs.readFile(lockPath, "utf8")))
      expect(lock.lockfileVersion).toBe(3)
      expect(lock.packages[""].dependencies[PluginSdk.packageName]).toMatch(/^file:/)

      yield* startup(test.directory, configDir)
      const afterSecond = yield* Effect.promise(() => lockSnapshot(lockPath))

      expect(afterSecond).toEqual(afterFirst)
    }),
  ),
)
