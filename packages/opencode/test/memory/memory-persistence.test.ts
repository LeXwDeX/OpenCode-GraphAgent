import { describe, expect } from "bun:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Exit, Layer, Schema } from "effect"
import path from "node:path"
import { MemoryConfig } from "@/memory/config"
import { MemoryHome } from "@/memory/home"
import { MemoryIdentityMigration } from "@/memory/identity-migration"
import { MemoryAdmission } from "@/memory/admission"
import { MemoryPaths } from "@/memory/paths"
import { MemorySchema } from "@/memory/schema"
import { MemoryStore } from "@/memory/store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))
const projectID = ProjectV2.ID.make("project-memory-test")
const otherProjectID = ProjectV2.ID.make("project-memory-other")
const now = "2026-08-11T00:00:00Z"

const config = {
  schema_version: 1,
  enabled: true,
  model: "test/memory-small",
  topic_limit: 10,
  topic_limit_floor: 10,
  turn_interval: 5,
  injection: { max_topics: 3, max_tokens: 1_200 },
} satisfies MemorySchema.Config

function topic(summary = "已确认的核心架构边界") {
  return {
    schema_version: 1,
    id: "project-architecture",
    name: "架构边界",
    summary,
    metadata: {
      categories: ["decision"],
      status: "active",
      importance: "core",
      keywords: ["架构"],
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
        id: "decision-01",
        kind: "decision",
        content: "已确认决定：核心模块之间使用稳定边界",
        rationale: "该边界由用户确认并长期适用",
        confirmed_at: now,
      },
    ],
  } satisfies MemorySchema.Topic
}

function terminologyTopic() {
  const value = topic("术语 Project Memory 指项目级持久化记忆")
  return {
    ...value,
    id: "project-memory-term",
    name: "Project Memory 术语",
    metadata: {
      ...value.metadata,
      categories: ["term"],
      keywords: ["Project Memory"],
    },
    items: [
      {
        id: "term-01",
        kind: "term",
        content: "术语 Project Memory 指项目级持久化记忆",
        rationale: "该术语由用户确认并长期适用",
        confirmed_at: now,
      },
    ],
  } satisfies MemorySchema.Topic
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
  return Layer.mergeAll(home, store, admission, MemoryConfig.defaultLayer)
}

function replaceTopics(store: MemoryStore.Interface, id: ProjectV2.ID, topics: MemorySchema.Topic[]) {
  return store
    .updateTopics(id, () => ({
      applied: { topics, changed: topics.map((topic) => topic.id), deleted: [] },
      result: undefined,
    }))
    .pipe(Effect.asVoid)
}

describe("Project-owned MEMORY persistence", () => {
  it.live("derives a path-safe home from Project identity", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const home = MemoryHome.make(root)
      const malicious = ProjectV2.ID.make("../../outside/project")
      const directory = home.directory(malicious)

      expect(path.relative(root, directory)).not.toStartWith("..")
      expect(path.dirname(directory)).toBe(path.join(root, "memory", "projects"))
      expect(home.directory(malicious)).toBe(directory)
      expect(home.directory(projectID)).not.toBe(home.directory(otherProjectID))
    }),
  )

  it.live("stores one authoritative Topic set per Project ID", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const store = yield* MemoryStore.Service
        const value = topic()
        yield* replaceTopics(store, projectID, [value])

        expect(yield* store.readTopics(projectID)).toEqual([value])
        expect(yield* store.readTopics(otherProjectID)).toEqual([])
        const manifest = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ generation: Schema.String })),
        )(yield* fs.readFileString(home.manifest(projectID)))
        const yaml = yield* fs.readFileString(path.join(home.generations(projectID), manifest.generation, `${value.id}.yaml`))
        expect(yaml).toContain("schema_version: 1")
        expect(yaml).toContain("metadata:")
        expect(MemoryStore.decodeTopic(value, "wrong-file-id")).toBeUndefined()
        expect(MemoryStore.decodeTopic({ ...value, extra: "not allowed" })).toBeUndefined()
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("moves the authoritative Topic set when Project identity changes", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const migration = yield* MemoryIdentityMigration.Service
        const store = yield* MemoryStore.Service
        const value = topic()
        yield* replaceTopics(store, projectID, [value])

        yield* migration.migrateHome(projectID, otherProjectID)

        expect(yield* store.readTopics(otherProjectID)).toEqual([value])
        expect(yield* fs.exists(home.directory(projectID))).toBe(false)
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
            layers(root),
          ),
        ),
      )
    }),
  )

  it.live("merges non-conflicting Topic sets when the new identity already has Memory", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const migration = yield* MemoryIdentityMigration.Service
        const store = yield* MemoryStore.Service
        const source = topic()
        const target = terminologyTopic()
        yield* replaceTopics(store, projectID, [source])
        yield* replaceTopics(store, otherProjectID, [target])

        yield* migration.migrateHome(projectID, otherProjectID)

        expect(yield* store.readTopics(otherProjectID)).toEqual([source, target])
        expect(yield* fs.exists(home.directory(projectID))).toBe(false)
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
            layers(root),
          ),
        ),
      )
    }),
  )

  it.live("fails closed when either Memory Home contains an unreadable Topic", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const migration = yield* MemoryIdentityMigration.Service
        const store = yield* MemoryStore.Service
        const target = terminologyTopic()
        const invalid = path.join(home.topics(projectID), "broken.yaml")
        yield* fs.makeDirectory(path.dirname(invalid), { recursive: true })
        yield* fs.writeFileString(invalid, "{ invalid")
        yield* replaceTopics(store, otherProjectID, [target])

        const exit = yield* Effect.exit(migration.migrateHome(projectID, otherProjectID))

        expect(exit._tag).toBe("Failure")
        expect(yield* fs.exists(invalid)).toBe(true)
        expect(yield* store.readTopics(otherProjectID)).toEqual([target])
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
            layers(root),
          ),
        ),
      )
    }),
  )

  it.live("preserves unknown Memory Home resources instead of deleting them during a merge", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const migration = yield* MemoryIdentityMigration.Service
        const store = yield* MemoryStore.Service
        const source = topic()
        const target = terminologyTopic()
        const unknown = path.join(home.directory(projectID), "future-resource.json")
        yield* replaceTopics(store, projectID, [source])
        yield* replaceTopics(store, otherProjectID, [target])
        yield* fs.writeFileString(unknown, "{}")

        const exit = yield* Effect.exit(migration.migrateHome(projectID, otherProjectID))

        expect(exit._tag).toBe("Failure")
        expect(yield* fs.exists(unknown)).toBe(true)
        expect(yield* store.readTopics(otherProjectID)).toEqual([target])
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
            layers(root),
          ),
        ),
      )
    }),
  )

  it.live("preserves both Memory Homes when the same Topic ID has different content", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const migration = yield* MemoryIdentityMigration.Service
        const store = yield* MemoryStore.Service
        const source = topic("已确认的架构接口边界")
        const target = topic("已确认的模块接口边界")
        yield* replaceTopics(store, projectID, [source])
        yield* replaceTopics(store, otherProjectID, [target])

        const exit = yield* Effect.exit(migration.migrateHome(projectID, otherProjectID))

        expect(exit._tag).toBe("Failure")
        expect(yield* store.readTopics(projectID)).toEqual([source])
        expect(yield* store.readTopics(otherProjectID)).toEqual([target])
        expect(yield* fs.exists(home.directory(projectID))).toBe(true)
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
            layers(root),
          ),
        ),
      )
    }),
  )

  it.live("imports, deduplicates, and preserves conflicting legacy Topics", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const sandbox = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const admission = yield* MemoryAdmission.Service
        const store = yield* MemoryStore.Service
        const file = path.join(MemoryPaths.legacyTopics(sandbox), "project-architecture.yaml")
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, Bun.YAML.stringify(topic()))

        const imported = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [primary, sandbox],
          updated: 1,
        })
        expect(imported.diagnostics.map((item) => item.code)).toEqual(["topic.imported"])
        expect(yield* fs.exists(file)).toBe(false)
        expect(yield* store.readTopics(projectID)).toEqual([topic()])
        expect(yield* fs.exists(home.manifest(projectID))).toBe(true)

        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, Bun.YAML.stringify(topic()))
        const duplicate = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [sandbox],
          updated: 2,
        })
        expect(duplicate.diagnostics.map((item) => item.code)).toEqual(["topic.duplicate"])
        expect(yield* fs.exists(file)).toBe(false)

        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, Bun.YAML.stringify(topic("不同的已确认架构边界")))
        const conflict = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [sandbox],
          updated: 3,
        })
        expect(conflict.diagnostics.map((item) => item.code)).toEqual(["topic.conflict"])
        expect(conflict.unresolved).toBe(1)
        expect(yield* fs.exists(file)).toBe(true)
        expect(yield* store.readTopics(projectID)).toEqual([topic()])
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("serializes concurrent migration attempts by Project ID", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const first = yield* tmpdirScoped()
      const second = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const admission = yield* MemoryAdmission.Service
        const store = yield* MemoryStore.Service
        const firstFile = path.join(MemoryPaths.legacyTopics(first), "project-architecture.yaml")
        const secondFile = path.join(MemoryPaths.legacyTopics(second), "project-architecture.yaml")
        yield* fs.makeDirectory(path.dirname(firstFile), { recursive: true })
        yield* fs.makeDirectory(path.dirname(secondFile), { recursive: true })
        yield* fs.writeFileString(firstFile, Bun.YAML.stringify(topic("first")))
        yield* fs.writeFileString(secondFile, Bun.YAML.stringify(topic("second")))

        const results = yield* Effect.all(
          [
            admission.ensure({ projectID, projectDirectory: primary, directories: [first], updated: 1 }),
            admission.ensure({ projectID, projectDirectory: primary, directories: [second], updated: 1 }),
          ],
          { concurrency: "unbounded" },
        )

        expect(results.flatMap((result) => result.diagnostics.map((item) => item.code)).sort()).toEqual([
          "topic.conflict",
          "topic.imported",
        ])
        expect(yield* store.readTopics(projectID)).toHaveLength(1)
        expect([yield* fs.exists(firstFile), yield* fs.exists(secondFile)].filter(Boolean)).toHaveLength(1)
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("preserves concurrent updates from separate processes", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const coordination = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        const value = topic()
        yield* replaceTopics(store, projectID, [value])
        const go = path.join(coordination, "go")
        const workers = [
          { itemID: "decision-a", content: "已确认决定：保留并发更新甲" },
          { itemID: "decision-b", content: "已确认决定：保留并发更新乙" },
        ].map((worker) => {
          const ready = path.join(coordination, `${worker.itemID}.ready`)
          const child = Bun.spawn([
            process.execPath,
            path.join(import.meta.dir, "../fixture/memory-store-worker.ts"),
            JSON.stringify({ root, projectID, ready, go, ...worker }),
          ])
          return { child, ready }
        })
        while (
          !(yield* Effect.promise(() =>
            Promise.all(workers.map((worker) => Bun.file(worker.ready).exists())).then((ready) => ready.every(Boolean)),
          ))
        )
          yield* Effect.sleep("5 millis")
        yield* Effect.promise(() => Bun.write(go, "go"))

        expect(yield* Effect.promise(() => Promise.all(workers.map((worker) => worker.child.exited)))).toEqual([0, 0])
        expect((yield* store.readTopics(projectID))[0]?.items.map((item) => item.id).sort()).toEqual([
          "decision-01",
          "decision-a",
          "decision-b",
        ])
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("recovers the complete committed generation after Store restart", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const value = topic()
      const committed = yield* Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        const initial = yield* store.readSnapshot(projectID)
        expect(initial).toEqual({ revision: 0, topics: [] })
        return yield* store.updateTopics(projectID, () => ({
          applied: { topics: [value], changed: [value.id], deleted: [] },
          result: undefined,
        }))
      }).pipe(Effect.provide(layers(root)))

      const recovered = yield* Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        return yield* store.readSnapshot(projectID)
      }).pipe(Effect.provide(layers(root)))

      expect(committed.revision).toBe(1)
      expect(recovered).toEqual({ revision: 1, topics: [value] })
    }),
  )

  it.live("rejects an invalid generation before publishing its manifest", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        const value = topic()
        yield* replaceTopics(store, projectID, [value])
        const invalid = { ...value, summary: "目标状态不允许进入 Project Memory" }

        const exit = yield* Effect.exit(
          store.updateTopics(projectID, () => ({
            applied: { topics: [invalid], changed: [invalid.id], deleted: [] },
            result: undefined,
          })),
        )

        expect(exit._tag).toBe("Failure")
        expect(yield* store.readSnapshot(projectID)).toEqual({ revision: 1, topics: [value] })
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("rejects a stale expected revision without replacing the committed generation", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        const first = topic()
        const stale = terminologyTopic()

        const committed = yield* store.commit(projectID, 0, {
          topics: [first],
          changed: [first.id],
          deleted: [],
        })
        const exit = yield* Effect.exit(
          store.commit(projectID, 0, {
            topics: [stale],
            changed: [stale.id],
            deleted: [],
          }),
        )

        expect(committed).toEqual({ revision: 1, topics: [first] })
        expect(exit._tag).toBe("Failure")
        expect(yield* store.readSnapshot(projectID)).toEqual(committed)
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("keeps invalid Topics and conflicting sandbox config for repair", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const sandbox = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const configStore = yield* MemoryConfig.Service
        const admission = yield* MemoryAdmission.Service
        const invalid = path.join(MemoryPaths.legacyTopics(sandbox), "broken.yaml")
        const sandboxConfig = path.join(sandbox, ".opencode", "memory.jsonc")
        yield* fs.makeDirectory(path.dirname(invalid), { recursive: true })
        yield* configStore.writeProject(primary, config)
        yield* fs.writeFileString(invalid, "{ invalid")
        yield* fs.writeFileString(sandboxConfig, JSON.stringify({ ...config, enabled: false }))

        const result = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [primary, sandbox],
          updated: 1,
        })
        expect(result.diagnostics.map((item) => item.code)).toEqual(["topic.invalid", "config.conflict"])
        expect(result.unresolved).toBe(2)
        expect(yield* fs.exists(invalid)).toBe(true)
        expect(yield* fs.exists(sandboxConfig)).toBe(true)

        yield* fs.writeFileString(sandboxConfig, JSON.stringify(config))
        const duplicate = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [sandbox],
          updated: 2,
        })
        expect(duplicate.diagnostics.map((item) => item.code)).toEqual(["topic.invalid", "config.duplicate"])
        expect(yield* fs.exists(sandboxConfig)).toBe(false)
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("promotes a sandbox config even when it matches the global fallback", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const sandbox = yield* tmpdirScoped()
      const global = yield* tmpdirScoped()
      const previous = process.env.OPENCODE_CONFIG_DIR

      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          process.env.OPENCODE_CONFIG_DIR = global
        }),
        () =>
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const admission = yield* MemoryAdmission.Service
            const sandboxConfig = path.join(sandbox, ".opencode", "memory.jsonc")
            yield* fs.writeFileString(path.join(global, "memory.jsonc"), JSON.stringify(config))
            yield* fs.makeDirectory(path.dirname(sandboxConfig), { recursive: true })
            yield* fs.writeFileString(sandboxConfig, JSON.stringify(config))

            const result = yield* admission.ensure({
              projectID,
              projectDirectory: primary,
              directories: [sandbox],
              updated: 1,
            })

            expect(result.diagnostics.map((item) => item.code)).toEqual(["config.promoted"])
            expect(yield* fs.exists(sandboxConfig)).toBe(false)
            expect((yield* (yield* MemoryConfig.Service).load(primary))?.level).toBe("project")
          }).pipe(Effect.provide(layers(root))),
        () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
            else process.env.OPENCODE_CONFIG_DIR = previous
          }),
      )
    }),
  )

  it.live("compares normalized project and sandbox configs", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const sandbox = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const configStore = yield* MemoryConfig.Service
        const admission = yield* MemoryAdmission.Service
        const value = { ...config, topic_limit: 50, topic_limit_floor: 10 }
        const sandboxConfig = path.join(sandbox, ".opencode", "memory.jsonc")
        yield* configStore.writeProject(primary, value)
        yield* fs.makeDirectory(path.dirname(sandboxConfig), { recursive: true })
        yield* fs.writeFileString(sandboxConfig, JSON.stringify(value))

        const result = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [sandbox],
          updated: 1,
        })

        expect(result.diagnostics.map((item) => item.code)).toEqual(["config.duplicate"])
        expect(yield* fs.exists(sandboxConfig)).toBe(false)
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live(
    "fails closed on a corrupt manifest and never deletes the unread Home (MEM-PR01-R1-02)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const migration = yield* MemoryIdentityMigration.Service
          const store = yield* MemoryStore.Service
          // Both identities hold Memory so the migration takes the merge path
          // (the rename fast path never deletes anything).
          yield* replaceTopics(store, projectID, [topic()])
          yield* replaceTopics(store, otherProjectID, [topic("新身份的主题")])

          // (a) invalid manifest JSON
          yield* fs.writeFileString(home.manifest(projectID), "{ not json")
          expect(Exit.isFailure(yield* Effect.exit(store.readSnapshot(projectID)))).toBe(true)
          const invalid = yield* Effect.exit(migration.migrateHome(projectID, otherProjectID))
          expect(Exit.isFailure(invalid)).toBe(true)
          expect(yield* fs.exists(home.directory(projectID))).toBe(true)

          // (b) manifest referencing a generation that does not exist
          yield* fs.writeFileString(
            home.manifest(projectID),
            JSON.stringify({ schema_version: 1, revision: 1, generation: "1-deadbeef" }) + "\n",
          )
          expect(Exit.isFailure(yield* Effect.exit(store.readSnapshot(projectID)))).toBe(true)
          const missing = yield* Effect.exit(migration.migrateHome(projectID, otherProjectID))
          expect(Exit.isFailure(missing)).toBe(true)
          expect(yield* fs.exists(home.directory(projectID))).toBe(true)
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
              layers(root),
            ),
          ),
        )
      }),
  )

  it.live(
    "rejects Topics whose item_count disagrees with their items (MEM-PR01-R1-20)",
    () =>
      Effect.gen(function* () {
        const base = topic()
        const drifted = { ...base, metadata: { ...base.metadata, item_count: base.items.length + 1 } }
        expect(MemoryStore.decodeTopic(drifted, drifted.id)).toBeUndefined()

        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const store = yield* MemoryStore.Service
          const exit = yield* Effect.exit(replaceTopics(store, projectID, [drifted]))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(yield* store.readTopics(projectID)).toEqual([])
        }).pipe(Effect.provide(layers(root)))
      }),
  )

  it.live(
    "an orphaned staging generation never shadows the committed generation (MEM-PR01-R1-21)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const store = yield* MemoryStore.Service
          const value = topic()
          yield* replaceTopics(store, projectID, [value])

          // Simulate a crash mid-writeSnapshot: a staging generation exists but
          // its manifest was never published.
          const staging = path.join(home.generations(projectID), ".2-orphaned.tmp")
          yield* fs.makeDirectory(staging, { recursive: true })
          yield* fs.writeFileString(path.join(staging, "orphan.yaml"), "id: orphan\n")

          expect(yield* store.readTopics(projectID)).toEqual([value])
          // The store still commits cleanly afterwards.
          const next = topic("第二版边界")
          yield* replaceTopics(store, projectID, [next])
          expect(yield* store.readTopics(projectID)).toEqual([next])
        }).pipe(Effect.provide(layers(root)))
      }),
  )
})
