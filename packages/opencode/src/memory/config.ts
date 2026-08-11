export * as MemoryConfig from "./config"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Git } from "@/git"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { MemoryFile } from "./file"
import { MemoryPaths } from "./paths"
import { MemorySchema } from "./schema"

export type Loaded = {
  readonly config: MemorySchema.Config
  readonly path: string
  readonly level: "project" | "global"
}

export interface Interface {
  readonly load: (projectDir: string) => Effect.Effect<Loaded | undefined, FSUtil.Error>
  readonly loadGlobal: () => Effect.Effect<Loaded | undefined, FSUtil.Error>
  readonly writeProject: (
    projectDir: string,
    config: MemorySchema.Config,
    existingPath?: string,
  ) => Effect.Effect<void, FSUtil.Error>
  readonly writeGlobal: (config: MemorySchema.Config, existingPath?: string) => Effect.Effect<boolean, FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryConfig") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service

    const ensureProjectExclude = Effect.fnUntraced(function* (projectDir: string) {
      const result = yield* git.run(["rev-parse", "--git-path", "info/exclude"], { cwd: projectDir })
      if (result.exitCode !== 0) return
      const raw = result.text().trim()
      if (!raw) return
      const file = isAbsolute(raw) ? raw : resolve(projectDir, raw)
      const current = (yield* fs.readFileStringSafe(file)) ?? ""
      const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()))
      const missing = MemoryPaths.PROJECT_CONFIG_PATHS.filter((rule) => !lines.has(rule))
      if (missing.length === 0) return
      const prefix = current.length === 0 || current.endsWith("\n") ? current : current + "\n"
      yield* MemoryFile.atomicWrite(fs, file, prefix + missing.join("\n") + "\n")
    })

    const readFirst = Effect.fnUntraced(function* (paths: string[]) {
      for (const path of paths) {
        const text = yield* fs.readFileStringSafe(path)
        if (text !== undefined) return { path, text }
      }
      return undefined
    })

    const readConfig = Effect.fnUntraced(function* (found: { path: string; text: string }) {
      const decoded = decodeConfig(found.text)
      if (Option.isNone(decoded)) {
        yield* Effect.logWarning("memory config is invalid — ignoring", { path: found.path })
        return undefined
      }
      if (decoded.value.topic_limit === decoded.value.topic_limit_floor) return decoded.value
      const config = normalizeConfig(decoded.value)
      yield* MemoryFile.atomicWrite(fs, found.path, serialize(config))
      return config
    })

    const load = Effect.fn("MemoryConfig.load")(function* (projectDir: string) {
      const found = yield* readFirst(candidates(projectDir))
      if (!found) return undefined
      const config = yield* readConfig(found)
      if (!config) return undefined
      return {
        config,
        path: found.path,
        level: projectCandidates(projectDir).includes(found.path) ? ("project" as const) : ("global" as const),
      }
    })

    const loadGlobal = Effect.fn("MemoryConfig.loadGlobal")(function* () {
      const found = yield* readFirst(globalCandidates())
      if (!found) return undefined
      const config = yield* readConfig(found)
      return config ? { config, path: found.path, level: "global" as const } : undefined
    })

    const writeProject = Effect.fn("MemoryConfig.writeProject")(function* (
      projectDir: string,
      config: MemorySchema.Config,
      existingPath?: string,
    ) {
      yield* ensureProjectExclude(projectDir)
      yield* MemoryFile.atomicWrite(fs, existingPath ?? projectPath(projectDir), serialize(config))
    })

    const writeGlobal = Effect.fn("MemoryConfig.writeGlobal")(function* (
      config: MemorySchema.Config,
      existingPath?: string,
    ) {
      if (existingPath && globalCandidates().includes(existingPath)) {
        yield* MemoryFile.atomicWrite(fs, existingPath, serialize(config))
        return true
      }
      const file = join(globalConfigDir(), "memory.jsonc")
      const found = yield* readFirst(globalCandidates())
      if (found) {
        if (yield* readConfig(found)) return false
        yield* MemoryFile.atomicWrite(fs, found.path, serialize(config))
        return true
      }
      yield* fs.makeDirectory(dirname(file), { recursive: true })
      return yield* fs.writeFileString(file, serialize(config), { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
      )
    })

    return Service.of({ load, loadGlobal, writeProject, writeGlobal })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))),
)

export const node = LayerNode.make(layer, [FSUtil.node, Git.node])

export function projectPath(projectDir: string) {
  return join(projectDir, ".opencode", "memory.jsonc")
}

export function candidates(projectDir: string) {
  return [...projectCandidates(projectDir), ...globalCandidates()]
}

export function globalConfigDir() {
  return Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config
}

export function projectCandidates(projectDir: string) {
  return [join(projectDir, ".opencode", "memory.jsonc"), join(projectDir, ".opencode", "memory.json")]
}

function globalCandidates() {
  return [join(globalConfigDir(), "memory.jsonc"), join(globalConfigDir(), "memory.json")]
}

function serialize(config: MemorySchema.Config) {
  return JSON.stringify(config, null, 2) + "\n"
}

export function decodeConfig(text: string) {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) return Option.none<MemorySchema.Config>()
  const decoded = Schema.decodeUnknownOption(MemorySchema.Config)(value ?? {})
  if (Option.isNone(decoded) || decoded.value.topic_limit < decoded.value.topic_limit_floor)
    return Option.none<MemorySchema.Config>()
  return decoded
}

export function normalizeConfig(config: MemorySchema.Config) {
  if (config.topic_limit === config.topic_limit_floor) return config
  return MemorySchema.updateConfig(config, { topic_limit_floor: config.topic_limit })
}
