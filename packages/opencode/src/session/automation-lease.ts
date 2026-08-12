export * as SessionAutomationLease from "./automation-lease"

import { Context, Effect, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

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
  // Sessions whose goal claim was rejected because a dag owns the automation
  // lease. Set by claim, cleared by a successful (or non-dag-rejected) goal
  // claim, and CONSUMED by the unregister re-trigger below — all under the
  // per-session lock, so the re-trigger decision is atomic with claim
  // serialization (GOAL-FP-01-02 follow-up / R1).
  const blockedGoalClaims = new Set<SessionID>()

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
    // GOAL-FP-01-02: when the dag ownership actually disappears (owner
    // transitions dag → goal/none), re-trigger the goal evaluation through
    // the EXISTING idle status event mechanism so a goal that yielded to the
    // dag on the last idle event gets a fresh evaluation. The final dag
    // unregister of a wake delivery (U2 in dag/runtime/loop.ts) lands AFTER
    // the wake turn's idle event — without this re-trigger the goal silently
    // stalls until the next external idle. This is also the GOAL-FP-01-11
    // mitigation surface: a claim that lost the ownership race gets another
    // chance once the owner actually transfers.
    //
    // The dag-release decision is computed atomically under the per-session
    // lock (compare owner before/after the Set removal, accounting for the
    // generation bump); the idle publish itself runs AFTER the lock. The
    // publish is an unconditional fire-and-forget bus enqueue — no interleave
    // can suppress it — and subscribers process it in their own fibers
    // (GoalLoop / DagLoop fork their work before touching the lease lock), so
    // no deadlock is possible. Set.delete is idempotent and only the removal
    // of the LAST dag flips the owner, so the emit cannot duplicate.
    //
    // R1 (GOAL-FP-01-02 follow-up): the re-trigger fires ONLY when a goal
    // claim was actually rejected by the dag (blockedGoalClaims). A rejected
    // claim's evaluation fiber yields at the claim itself, so the retry
    // evaluation it spawns is the only evaluation in flight — the duplicate
    // evaluation that raced the turn-idle fiber (double commit / interrupt
    // between commit and dispatch) is unconstructible. A successful goal
    // claim clears the flag (under the same lock), so a release that a
    // boundary evaluation already picked up does not double-fire.
    const goalRetryDue = yield* locks.withLock(sessionID)(
      Effect.sync(() => {
        const current = registrations.get(sessionID)
        if (!current) return false
        const before = owner(sessionID)
        const values = value.kind === "dag" ? current.dags : current.goals
        if (!values.delete(value.id)) return false
        current.generation += 1
        if (current.goals.size === 0 && current.dags.size === 0) registrations.delete(sessionID)
        const after = owner(sessionID)
        if (before?.kind !== "dag" || after?.kind === "dag") return false
        // Consume the retry obligation: exactly one re-trigger per blocked
        // claim, even when several dags release back-to-back.
        return blockedGoalClaims.delete(sessionID)
      }),
    )
    if (!goalRetryDue) return
    // SessionStatus is resolved optionally: automation-lease is deliberately
    // dependency-free (consumers wire it standalone, e.g.
    // test/session/automation-lease.test.ts), and every entry point that runs
    // the lease (AppLayer, DagLoop, GoalLoop) provides SessionStatus. Without
    // it the re-trigger degrades to the pre-fix behavior (the caller's next
    // idle event still drives the goal — claim re-evaluation is never
    // load-bearing for correctness of the lease itself).
    const status = yield* Effect.serviceOption(SessionStatus.Service)
    if (Option.isNone(status)) return
    // Only re-trigger when the session is actually idle: a busy session's
    // turn ALWAYS re-emits idle when it finishes (runner onIdle →
    // SessionStatus.set), which re-drives the goal claim with the dag already
    // released. Emitting here mid-turn would waste a judge call and transiently
    // drop the busy entry from the status map.
    if ((yield* status.value.get(sessionID)).type !== "idle") return
    yield* status.value.set(sessionID, { type: "idle" })
  })

  const claim = Effect.fn("SessionAutomationLease.claim")(function* (
    sessionID: SessionID,
    request: Request,
  ) {
    return yield* locks.withLock(sessionID)(
      Effect.sync(() => {
        const current = registrations.get(sessionID)
        const selected = owner(sessionID)
        if (request.kind === "goal") {
          // Track dag-blocked goal claims: the unregister re-trigger only
          // fires for sessions whose goal evaluation was actually rejected by
          // a dag owner. Any other outcome (success, or a rejection that is
          // not dag-blocking) clears the obligation.
          if (selected?.kind === "dag") blockedGoalClaims.add(sessionID)
          else blockedGoalClaims.delete(sessionID)
        }
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
