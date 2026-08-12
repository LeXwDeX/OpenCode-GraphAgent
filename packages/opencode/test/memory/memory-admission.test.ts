import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Duration, Effect, Fiber, Layer } from "effect"
import path from "node:path"
import { MemoryAdmission } from "@/memory/admission"
import { MemoryConfig } from "@/memory/config"
import { MemoryHome } from "@/memory/home"
import { MemoryStore } from "@/memory/store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))
const projectID = ProjectV2.ID.make("project-memory-admission")
const config = {
  schema_version: 1,
  enabled: true,
  model: "test/memory-small",
  topic_limit: 10,
  topic_limit_floor: 10,
  turn_interval: 5,
  injection: { max_topics: 3, max_tokens: 1_200 },
} as const
const now = "2026-08-11T00:00:00Z"

function topic(id: string, summary = `已确认的 ${id} 决策`) {
  return {
    schema_version: 1,
    id,
    name: `${id} 决策`,
    summary,
    metadata: {
      categories: ["decision"],
      status: "active",
      importance: "core",
      keywords: [id],
      related_topics: [],
      created_at: now,
      updated_at: now,
      last_matched_at: null,
      match_count: 0,
      revision: 1,
      item_count: 1,
    },
    items: [
      {
        id: `${id}-item`,
        kind: "decision",
        content: `已确认决定：保留 ${id} 边界`,
        rationale: "该边界由用户确认并长期适用",
        confirmed_at: now,
      },
    ],
  } as const
}

function layers(root: string) {
  const home = Layer.succeed(MemoryHome.Service, MemoryHome.make(root))
  const store = MemoryStore.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(home),
  )
  const admission = MemoryAdmission.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(MemoryConfig.defaultLayer),
    Layer.provide(home),
    Layer.provide(store),
  )
  return Layer.mergeAll(admission, store, MemoryConfig.defaultLayer)
}

describe("MemoryAdmission", () => {
  it.live("promotes one normalized sandbox configuration when the Project has no explicit configuration", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const first = yield* tmpdirScoped()
      const second = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const admission = yield* MemoryAdmission.Service
        const configStore = yield* MemoryConfig.Service
        const files = [first, second].map((directory) => path.join(directory, ".opencode", "memory.jsonc"))
        yield* Effect.forEach(files, (file) => fs.makeDirectory(path.dirname(file), { recursive: true }), {
          concurrency: 1,
          discard: true,
        })
        yield* Effect.forEach(files, (file) => fs.writeFileString(file, JSON.stringify(config)), {
          concurrency: 1,
          discard: true,
        })

        const result = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [primary, first, second],
          updated: 1,
        })

        expect(result.diagnostics.map((item) => item.code)).toEqual(["config.promoted", "config.duplicate"])
        expect((yield* configStore.load(primary))?.config).toEqual(config)
        expect(yield* Effect.forEach(files, (file) => fs.existsSafe(file))).toEqual([false, false])
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("caches one Project snapshot until worktree lifecycle invalidates it", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const sandbox = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const admission = yield* MemoryAdmission.Service
        const snapshot = { projectID, projectDirectory: primary, directories: [primary, sandbox], updated: 1 }

        expect((yield* admission.ensure(snapshot)).diagnostics).toEqual([])
        const file = path.join(sandbox, ".opencode", "memory", "topics", "late.yaml")
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, "{ invalid")

        expect((yield* admission.ensure(snapshot)).diagnostics).toEqual([])
        yield* admission.invalidate(projectID)
        expect((yield* admission.ensure(snapshot)).diagnostics.map((item) => item.code)).toEqual(["topic.invalid"])
        expect(yield* fs.existsSafe(file)).toBe(true)
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("imports every worktree Topic in one Project revision", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const first = yield* tmpdirScoped()
      const second = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const admission = yield* MemoryAdmission.Service
        const store = yield* MemoryStore.Service
        const topics = [topic("architecture"), topic("product")]
        const files = [first, second].map((directory, index) =>
          path.join(directory, ".opencode", "memory", "topics", `${topics[index].id}.yaml`),
        )
        yield* Effect.forEach(files, (file, index) =>
          fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
            Effect.andThen(fs.writeFileString(file, Bun.YAML.stringify(topics[index]))),
          ),
        )

        const result = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [primary, first, second],
          updated: 1,
        })

        expect(result.diagnostics.map((item) => item.code)).toEqual(["topic.imported", "topic.imported"])
        expect(yield* store.readSnapshot(projectID)).toMatchObject({ revision: 1, topics })
        expect(yield* Effect.forEach(files, (file) => fs.existsSafe(file))).toEqual([false, false])
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  const fullLayers = (root: string) => {
    const home = Layer.succeed(MemoryHome.Service, MemoryHome.make(root))
    const flock = EffectFlock.defaultLayer
    const base = Layer.mergeAll(FSUtil.defaultLayer, flock, home, MemoryConfig.defaultLayer)
    const store = MemoryStore.layer.pipe(Layer.provide(base))
    const admission = MemoryAdmission.layer.pipe(Layer.provide(base), Layer.provide(store))
    return Layer.mergeAll(base, store, admission)
  }

  it.live(
    "preserves a legacy topic file whose content changes between the scan and the delete (MEM-PR01-R1-04)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const primary = yield* tmpdirScoped({ git: true })
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const flock = yield* EffectFlock.Service
          const home = yield* MemoryHome.Service
          const admission = yield* MemoryAdmission.Service
          const store = yield* MemoryStore.Service

          const dir = path.join(primary, ".opencode", "memory", "topics")
          const file = path.join(dir, "moving-topic.yaml")
          yield* fs.makeDirectory(dir, { recursive: true })
          const original = topic("moving-topic")
          yield* fs.writeFileString(file, Bun.YAML.stringify(original))

          // Hold the store's project lock while ensure() runs: it scans first
          // (reading the original), then blocks in updateTopics behind this lock.
          // While it blocks, a concurrent writer that does not take the admission
          // flock (older runtime, hand edit) replaces the file. When the lock is
          // released the migration continues — the delete must then see the
          // changed content and preserve the file instead of destroying it.
          const ensureFiber = yield* flock.withLock(
            Effect.gen(function* () {
              const fiber = yield* admission
                .ensure({ projectID, projectDirectory: primary, directories: [primary], updated: 1 })
                .pipe(Effect.forkDetach)
              yield* Effect.sleep(Duration.millis(500))
              const modified = { ...original, summary: "迁移进行中被并发写入的新摘要" }
              yield* fs.writeFileString(file, Bun.YAML.stringify(modified))
              return fiber
            }),
            `memory-project:${projectID}`,
            home.locks,
          )
          const result = yield* Fiber.join(ensureFiber)

          expect(yield* fs.existsSafe(file)).toBe(true)
          expect(result.diagnostics.some((item) => item.code === "topic.conflict")).toBe(true)
          // The scanned version still landed in Project Memory exactly once.
          const snapshot = yield* store.readSnapshot(projectID)
          expect(snapshot.topics.filter((value) => value.id === "moving-topic")).toHaveLength(1)
        }).pipe(Effect.provide(fullLayers(root)))
      }),
      { timeout: 30_000 },
  )

  it.live(
    "follows the loader's jsonc-over-json precedence and diagnoses an in-project config fork (MEM-PR01-R1-10)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const primary = yield* tmpdirScoped({ git: true })
        const sandbox = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const admission = yield* MemoryAdmission.Service

          const configA = { ...config, model: "test/config-jsonc" }
          const configB = { ...config, model: "test/config-json" }
          const opencode = path.join(primary, ".opencode")
          yield* fs.makeDirectory(opencode, { recursive: true })
          // The loader (MemoryConfig.load) prefers memory.jsonc; admission must
          // agree, and the disagreeing memory.json must be diagnosed as a fork
          // instead of silently becoming authoritative.
          yield* fs.writeFileString(path.join(opencode, "memory.jsonc"), JSON.stringify(configA))
          yield* fs.writeFileString(path.join(opencode, "memory.json"), JSON.stringify(configB))
          // A sandbox legacy config equal to the NON-effective json content must
          // not be deleted as a duplicate of the effective config.
          const sandboxFile = path.join(sandbox, ".opencode", "memory.jsonc")
          yield* fs.makeDirectory(path.dirname(sandboxFile), { recursive: true })
          yield* fs.writeFileString(sandboxFile, JSON.stringify(configB))

          const result = yield* admission.ensure({
            projectID,
            projectDirectory: primary,
            directories: [primary, sandbox],
            updated: 1,
          })

          const fork = result.diagnostics.filter((item) => item.path.endsWith("memory.json"))
          expect(fork.length).toBe(1)
          expect(fork[0].code).toBe("config.conflict")
          expect(result.diagnostics.some((item) => item.path === sandboxFile && item.code === "config.conflict")).toBe(true)
          expect(yield* fs.existsSafe(sandboxFile)).toBe(true)
          expect(result.unresolved).toBeGreaterThan(0)
        }).pipe(Effect.provide(fullLayers(root)))
      }),
      { timeout: 30_000 },
  )
})
