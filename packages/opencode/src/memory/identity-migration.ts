export * as MemoryIdentityMigration from "./identity-migration"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Context, Effect, Layer, Schema } from "effect"
import { dirname, join } from "node:path"
import { MemoryHome } from "./home"
import { MemoryStore } from "./store"

export interface Interface {
  readonly migrateHome: (
    oldID: ProjectV2.ID,
    newID: ProjectV2.ID,
  ) => Effect.Effect<
    void,
    FSUtil.Error | EffectFlock.LockError | MemoryStore.StoreError | ConflictError | InvalidHomeError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryIdentityMigration") {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("MemoryIdentityMigration.Conflict", {
  topic_ids: Schema.Array(Schema.String),
}) {}

export class InvalidHomeError extends Schema.TaggedErrorClass<InvalidHomeError>()(
  "MemoryIdentityMigration.InvalidHome",
  {
    paths: Schema.Array(Schema.String),
  },
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const home = yield* MemoryHome.Service
    const store = yield* MemoryStore.Service

    const inspectHome = Effect.fnUntraced(function* (directory: string) {
      const unexpected = (yield* fs.readDirectoryEntries(directory)).filter(
        (entry) =>
          !(
            (entry.name === "topics" && entry.type === "directory") ||
            (entry.name === "generations" && entry.type === "directory") ||
            (entry.name === "manifest.json" && entry.type === "file")
          ),
      )
      if (unexpected.length === 0) return
      yield* new InvalidHomeError({ paths: unexpected.map((entry) => join(directory, entry.name)) })
    })

    const migrateHomeUnsafe = Effect.fnUntraced(function* (
      oldID: ProjectV2.ID,
      newID: ProjectV2.ID,
    ) {
      const source = home.directory(oldID)
      if (!(yield* fs.existsSafe(source))) return
      const target = home.directory(newID)
      yield* fs.makeDirectory(dirname(target), { recursive: true })
      if (!(yield* fs.existsSafe(target))) {
        yield* fs.rename(source, target)
        return
      }

      yield* inspectHome(source)
      yield* inspectHome(target)
      const sourceTopics = yield* store.inspectTopics(oldID)
      const targetTopics = yield* store.inspectTopics(newID)
      const targetByID = new Map(targetTopics.map((topic) => [topic.id, topic]))
      const conflicts = sourceTopics
        .filter((topic) => {
          const current = targetByID.get(topic.id)
          return current && JSON.stringify(current) !== JSON.stringify(topic)
        })
        .map((topic) => topic.id)
      if (conflicts.length > 0) yield* new ConflictError({ topic_ids: conflicts })

      const imported = sourceTopics.filter((topic) => !targetByID.has(topic.id))
      if (imported.length > 0) {
        yield* store.updateTopics(newID, (topics) => {
          const current = new Map(topics.map((topic) => [topic.id, topic]))
          const conflicts = imported.filter((topic) => {
            const existing = current.get(topic.id)
            return existing && JSON.stringify(existing) !== JSON.stringify(topic)
          })
          if (conflicts.length > 0)
            throw new MemoryStore.StoreError({
              message: `Memory identity migration conflicted for Topics: ${conflicts.map((topic) => topic.id).join(", ")}`,
            })
          const changed = imported.filter((topic) => !current.has(topic.id))
          changed.forEach((topic) => current.set(topic.id, topic))
          return {
            applied: {
              topics: Array.from(current.values()).sort((left, right) => left.id.localeCompare(right.id)),
              changed: changed.map((topic) => topic.id),
              deleted: [],
            },
            result: undefined,
          }
        })
      }
      yield* fs.remove(source, { recursive: true })
    })

    const migrateHome: Interface["migrateHome"] = (oldID, newID) => {
      if (oldID === newID) return Effect.void
      return flock
        .withLock(migrateHomeUnsafe(oldID, newID), `memory-project:${oldID}`, home.locks)
        .pipe(Effect.asVoid, Effect.withSpan("MemoryIdentityMigration.migrateHome"))
    }

    return Service.of({ migrateHome })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(MemoryHome.defaultLayer),
  Layer.provide(MemoryStore.defaultLayer),
)

export const node = LayerNode.make(layer, [FSUtil.node, EffectFlock.node, MemoryHome.node, MemoryStore.node])
