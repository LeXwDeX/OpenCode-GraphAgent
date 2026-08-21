import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs"
import path from "node:path"
import { Config } from "@/config/config"
import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Memory } from "@/memory/memory"
import { MemoryAdmission } from "@/memory/admission"
import { MemoryConfig } from "@/memory/config"
import { MemoryHome } from "@/memory/home"
import { MemoryIdentityFence } from "@/memory/identity-fence"
import { MemoryLock } from "@/memory/lock"
import { MemoryStore } from "@/memory/store"
import { MemoryModel } from "@/memory/model"
import { ProviderTest } from "../fake/provider"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// #415: the /init stamp is written by a Command.Event.Executed listener that can
// lose the race with the command itself, leaving time_initialized NULL forever.
// The activation gate must self-heal: a project that already has the /init
// artifact (non-empty AGENTS.md) passes without re-running /init, and a project
// without it still reports the blocker — now with the DB row state attached.

const emptyConfigLayer = Layer.mock(Config.Service, {
  get: () => Effect.succeed({}),
})

const base = Layer.mergeAll(
  emptyConfigLayer,
  ProviderTest.fake().layer,
  Project.defaultLayer,
  Database.defaultLayer,
  Git.defaultLayer,
  FSUtil.defaultLayer,
  EffectFlock.defaultLayer,
  MemoryAdmission.defaultLayer,
  MemoryConfig.defaultLayer,
  MemoryHome.defaultLayer,
  MemoryIdentityFence.defaultLayer,
  MemoryLock.defaultLayer,
  MemoryStore.defaultLayer,
  Layer.mock(MemoryModel.Service, {
    generate: () => Effect.die(new Error("model calls are not expected in self-heal tests")),
  }),
)

// provideMerge builds `base` once, provides it to Memory.layer AND re-exposes its
// services (Project/MemoryConfig/MemoryStore/...) to the test body.
const layer = Layer.mergeAll(Memory.layer.pipe(Layer.provideMerge(base)), CrossSpawnSpawner.defaultLayer)

const it = testEffect(layer)

describe("memory /init stamp self-heal", () => {
  it.live(
    "statusReason stamps the project when AGENTS.md already exists",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service

            const { project: info } = yield* project.fromDirectory(dir)
            expect(info.id).not.toBe(ProjectV2.ID.global)
            // The artifact /init produces: a non-empty AGENTS.md in the worktree.
            fs.writeFileSync(path.join(info.worktree, "AGENTS.md"), "# project guide\n")

            // Gate self-heals instead of reporting the blocker...
            expect(yield* memory.statusReason()).toBeUndefined()
            // ...and the stamp actually landed in the DB row.
            const stamped = yield* project.get(info.id)
            expect(stamped?.time.initialized).toBeDefined()
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "statusReason keeps blocking without AGENTS.md and reports the DB state",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service

            const { project: info } = yield* project.fromDirectory(dir)
            expect(info.id).not.toBe(ProjectV2.ID.global)

            const reason = yield* memory.statusReason()
            expect(reason).toContain("/init")
            // #415 diagnostics: the blocker carries the actual row state so a
            // stale identity (worktree pointing at a deleted clone) is visible.
            expect(reason).toContain("time_initialized")
            expect(reason).toContain(info.worktree)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )
})
