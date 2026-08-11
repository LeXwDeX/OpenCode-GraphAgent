export * as ProjectIdentityMigration from "./identity-migration"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Context, Effect, Layer } from "effect"
import { MemoryIdentityMigration } from "@/memory/identity-migration"

export interface Interface {
  readonly migrate: (oldID: ProjectV2.ID, newID: ProjectV2.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectIdentityMigration") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const memory = yield* MemoryIdentityMigration.Service
    return Service.of({
      migrate: (oldID, newID) => memory.migrateHome(oldID, newID).pipe(Effect.orDie),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(MemoryIdentityMigration.defaultLayer))

export const node = LayerNode.make(layer, [MemoryIdentityMigration.node])
