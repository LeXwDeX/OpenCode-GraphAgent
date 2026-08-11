export * as SessionAutomationLease from "./automation-lease"

import { Context, Effect, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { SessionID } from "./schema"

export type Owner =
  | { readonly kind: "goal"; readonly id: string }
  | { readonly kind: "dag"; readonly id: string }

export interface Token {
  readonly sessionID: SessionID
  readonly owner: Owner
  readonly generation: number
}

type Request =
  | { readonly kind: "goal"; readonly id: string }
  | { readonly kind: "dag" }

export interface Interface {
  readonly register: (sessionID: SessionID, owner: Owner) => Effect.Effect<void>
  readonly unregister: (sessionID: SessionID, owner: Owner) => Effect.Effect<void>
  readonly claim: (sessionID: SessionID, request: Request) => Effect.Effect<Option.Option<Token>>
  readonly use: <A, E, R>(token: Token, effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAutomationLease") {}

export const layer = Layer.sync(Service, () => {
  const locks = KeyedMutex.makeUnsafe<SessionID>()
  const registrations = new Map<
    SessionID,
    { readonly goals: Set<string>; readonly dags: Set<string>; generation: number }
  >()

  const entry = (sessionID: SessionID) => {
    const current = registrations.get(sessionID)
    if (current) return current
    const created = { goals: new Set<string>(), dags: new Set<string>(), generation: 0 }
    registrations.set(sessionID, created)
    return created
  }

  const owner = (sessionID: SessionID): Owner | undefined => {
    const current = registrations.get(sessionID)
    const dag = current?.dags.values().next().value
    if (dag) return { kind: "dag", id: dag }
    const goal = current?.goals.values().next().value
    if (goal) return { kind: "goal", id: goal }
    return undefined
  }

  const register = Effect.fn("SessionAutomationLease.register")(function* (
    sessionID: SessionID,
    value: Owner,
  ) {
    yield* locks.withLock(sessionID)(
      Effect.sync(() => {
        const current = entry(sessionID)
        const values = value.kind === "dag" ? current.dags : current.goals
        if (values.has(value.id)) return
        values.add(value.id)
        current.generation += 1
      }),
    )
  })

  const unregister = Effect.fn("SessionAutomationLease.unregister")(function* (
    sessionID: SessionID,
    value: Owner,
  ) {
    yield* locks.withLock(sessionID)(
      Effect.sync(() => {
        const current = registrations.get(sessionID)
        if (!current) return
        const values = value.kind === "dag" ? current.dags : current.goals
        if (!values.delete(value.id)) return
        current.generation += 1
        if (current.goals.size === 0 && current.dags.size === 0) registrations.delete(sessionID)
      }),
    )
  })

  const claim = Effect.fn("SessionAutomationLease.claim")(function* (
    sessionID: SessionID,
    request: Request,
  ) {
    return yield* locks.withLock(sessionID)(
      Effect.sync(() => {
        const current = registrations.get(sessionID)
        const selected = owner(sessionID)
        if (!current || !selected) return Option.none<Token>()
        if (request.kind === "goal" && (selected.kind !== "goal" || selected.id !== request.id))
          return Option.none<Token>()
        if (request.kind === "dag" && selected.kind !== "dag") return Option.none<Token>()
        return Option.some({ sessionID, owner: selected, generation: current.generation })
      }),
    )
  })

  const use: Interface["use"] = Effect.fn("SessionAutomationLease.use")(function* (token, effect) {
    const valid = yield* locks.withLock(token.sessionID)(
      Effect.sync(() => {
        const current = registrations.get(token.sessionID)
        const selected = owner(token.sessionID)
        return !(
          !current ||
          current.generation !== token.generation ||
          selected?.kind !== token.owner.kind ||
          selected.id !== token.owner.id
        )
      }),
    )
    if (!valid) return Option.none()
    return Option.some(yield* effect)
  })

  return Service.of({ register, unregister, claim, use })
})

export const defaultLayer = layer
export const node = LayerNode.make(layer, [])
