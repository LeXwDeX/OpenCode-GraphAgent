import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import fs from "node:fs"
import path from "node:path"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { MemoryAdmission } from "@/memory/admission"
import { MemoryConfig } from "@/memory/config"
import { MemoryLock } from "@/memory/lock"
import { Memory } from "@/memory/memory"
import { MemoryModel } from "@/memory/model"
import { MemorySchema } from "@/memory/schema"
import { MemoryStore } from "@/memory/store"
import { Project } from "@/project/project"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderTest } from "../fake/provider"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const now = "2026-08-12T12:00:00Z"
const providerID = ProviderV2.ID.make("test")
const enabledModel = ProviderTest.model({ providerID, id: ModelV2.ID.make("memory-on") })

const baseConfig = {
  schema_version: 1,
  enabled: true,
  model: "test/memory-on",
  topic_limit: 10,
  topic_limit_floor: 10,
  turn_interval: 5,
  injection: { max_topics: 3, max_tokens: 1_200 },
} satisfies MemorySchema.Config

function topic() {
  return {
    schema_version: 1,
    id: "project-architecture",
    name: "架构边界",
    summary: "已确认的核心架构边界",
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

function userMessage(sessionID: SessionID): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "user",
      sessionID,
      time: { created: 1 },
      agent: "build",
      model: { providerID, modelID: ModelV2.ID.make("memory-on") },
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID,
        type: "text",
        text: "架构边界是什么？",
      },
    ],
  }
}

const emptyConfigLayer = Layer.mock(Config.Service, {
  get: () => Effect.succeed({}),
})

const base = Layer.mergeAll(
  emptyConfigLayer,
  ProviderTest.fake({ model: enabledModel }).layer,
  Project.defaultLayer,
  Database.defaultLayer,
  Git.defaultLayer,
  MemoryAdmission.defaultLayer,
  MemoryConfig.defaultLayer,
  MemoryLock.defaultLayer,
  MemoryStore.defaultLayer,
  Layer.mock(MemoryModel.Service, {
    generate: () => Effect.die(new Error("model calls are not expected in global-identity tests")),
  }),
)

// provideMerge builds `base` once, provides it to Memory.layer AND re-exposes its
// services (Project/MemoryConfig/MemoryStore/...) to the test body. CrossSpawnSpawner
// is merged at the top level so the body itself can spawn git for the fixtures.
const layer = Layer.mergeAll(Memory.layer.pipe(Layer.provideMerge(base)), CrossSpawnSpawner.defaultLayer)

const it = testEffect(layer)

// A git repository WITHOUT any commit: identity resolution finds no remote, no
// cached id and no root commit, so it falls back to the shared ProjectV2.ID.global.
function gitInitWithoutCommit(dir: string) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const git = (...args: string[]) =>
      spawner.spawn(ChildProcess.make("git", args, { cwd: dir })).pipe(Effect.flatMap((handle) => handle.exitCode))
    yield* git("init")
    yield* git("config", "core.fsmonitor", "false")
    yield* git("config", "commit.gpgsign", "false")
    yield* git("config", "user.email", "test@opencode.test")
    yield* git("config", "user.name", "Test")
  })
}

describe("MEM-PR01-00: memory is inert under the shared global identity", () => {
  it.live(
    "search reports unavailable for a commit-less repository even when global config enables memory and the shared bucket holds topics",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        yield* gitInitWithoutCommit(dir)
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service
            const configStore = yield* MemoryConfig.Service
            const store = yield* MemoryStore.Service

            const { project: info } = yield* project.fromDirectory(dir)
            expect(info.id).toBe(ProjectV2.ID.global)
            yield* project.setInitialized(info.id)

            // An enabled global config must NOT activate memory for a project that
            // has no identity of its own: every commit-less repository on the
            // machine resolves to the same global bucket, so any read or write
            // would leak across repositories and be orphaned by the first commit.
            yield* configStore.writeGlobal(baseConfig)
            // Simulate another commit-less repository having written into the
            // shared bucket: memory must still refuse to serve it from here.
            const seeded = topic()
            yield* store.updateTopics(info.id, () => ({
              applied: { topics: [seeded], changed: [seeded.id], deleted: [] },
              result: undefined,
            }))

            const sessionID = SessionID.make("ses_global_identity")
            const result = yield* memory.search({
              sessionID,
              messages: [userMessage(sessionID)],
              query: "架构边界",
            })
            expect(result.status).toBe("unavailable")
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "/memory on stays off for a commit-less repository and writes no project config",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        yield* gitInitWithoutCommit(dir)
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service
            const configStore = yield* MemoryConfig.Service

            const { project: info } = yield* project.fromDirectory(dir)
            expect(info.id).toBe(ProjectV2.ID.global)
            yield* project.setInitialized(info.id)
            yield* configStore.writeGlobal(baseConfig)

            expect(yield* memory.setEnabled(true)).toBe("Memory remains off")
            expect(fs.existsSync(path.join(dir, ".opencode", "memory.jsonc"))).toBe(false)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "inertness is identity-scoped: a repository with a commit activates normally under its real identity",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service
            const configStore = yield* MemoryConfig.Service

            const { project: info } = yield* project.fromDirectory(dir)
            expect(info.id).not.toBe(ProjectV2.ID.global)
            yield* project.setInitialized(info.id)
            yield* configStore.writeGlobal(baseConfig)

            const sessionID = SessionID.make("ses_real_identity")
            const result = yield* memory.search({
              sessionID,
              messages: [userMessage(sessionID)],
              query: "架构边界",
            })
            // Active (model calls are stubbed to fail, so search cannot succeed —
            // but it must get PAST the activation gate, i.e. not "unavailable").
            expect(result.status).not.toBe("unavailable")
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )
})
