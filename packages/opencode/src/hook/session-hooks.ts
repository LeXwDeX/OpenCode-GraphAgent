/**
 * Session-scoped hook store (WP-5D).
 *
 * Holds hook entries that were dynamically attached to a single session. The
 * canonical producer is the HTTP API session-hook endpoints (POST/GET/DELETE
 * under `/session/:id/hook`); anything that can speak HTTP — plugins, the TUI,
 * external clients, tests — can register a hook for the session's lifetime.
 * These hooks live alongside the 6-layer settings file chain — `SettingsHook.trigger`
 * concatenates session entries into the matcher list so they participate in
 * the same matcher / aggregation pipeline as on-disk hooks.
 *
 * Lifecycle:
 *   - `add(sessionID, entry)` — append; returns a uuid for later precise removal
 *   - `list(sessionID, event)` — query active entries for one event
 *   - `listAll(sessionID)` — query all active entries for a session (HTTP GET)
 *   - `remove(sessionID, id)` — drop a single entry (used by `once: true` cleanup)
 *   - `clear(sessionID)` — drop the whole session bucket (call on session end)
 *
 * Uses `InstanceState` for per-directory isolation (mirrors `start-context.ts`).
 * Storage is process-local memory — entries do NOT survive a restart; users
 * wanting persistent hooks should use the on-disk hooks.json chain.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import type { HookEvent, HookJSONOutput, HookCommand } from "./settings"
import { HookCommandSchema } from "./schema"

export type SessionHookCommand = HookCommand

export class InvalidHookError extends Schema.TaggedErrorClass<InvalidHookError>()("InvalidHookError", {
  message: Schema.String,
}) {}

export interface SessionHookEntryInput {
  event: HookEvent
  /** CC matcher pattern (exact / pipe-list / regex / "*"). Undefined = match all. */
  matcher?: string
  hooks: SessionHookCommand[]
  /** When true, the entry is removed automatically after its first execution. */
  once?: boolean
}

export interface SessionHookEntry extends SessionHookEntryInput {
  /** Auto-generated uuid. Stable for the entry's lifetime; used by remove(). */
  id: string
}

export interface Interface {
  readonly add: (sessionID: SessionID, entry: SessionHookEntryInput) => Effect.Effect<string, InvalidHookError>
  /** Atomically remove a registration if still present; only one trigger can claim it. */
  readonly claim: (sessionID: SessionID, id: string) => Effect.Effect<boolean>
  readonly remove: (sessionID: SessionID, id: string) => Effect.Effect<void>
  readonly list: (sessionID: SessionID, event: HookEvent) => Effect.Effect<readonly SessionHookEntry[]>
  /** All entries for a session across every event (backs the HTTP GET endpoint). */
  readonly listAll: (sessionID: SessionID) => Effect.Effect<readonly SessionHookEntry[]>
  /**
   * O(1) existence probe — answers "does this session have any hook for this event?"
   * Used by WP-6A short-circuit in SettingsHook.trigger to skip the matcher pipeline
   * when no session-scoped hook (and no on-disk hook) targets the current event.
   */
  readonly hasForEvent: (sessionID: SessionID, event: HookEvent) => Effect.Effect<boolean>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionHooks") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(
      Effect.fn("SessionHooks.state")(() => Effect.succeed(new Map<SessionID, SessionHookEntry[]>())),
    )

    const add = Effect.fn("SessionHooks.add")(function* (sessionID: SessionID, entry: SessionHookEntryInput) {
      const parsed = HookCommandSchema.array().min(1).safeParse(entry.hooks)
      if (!parsed.success) return yield* new InvalidHookError({ message: parsed.error.message })
      if (entry.matcher !== undefined && typeof entry.matcher !== "string")
        return yield* new InvalidHookError({ message: "matcher must be a string" })
      const data = yield* InstanceState.get(state)
      const list = data.get(sessionID) ?? []
      const id = crypto.randomUUID()
      list.push({ ...entry, id, hooks: parsed.data })
      data.set(sessionID, list)
      return id
    })

    const claim = Effect.fn("SessionHooks.claim")(function* (sessionID: SessionID, id: string) {
      const data = yield* InstanceState.get(state)
      const list = data.get(sessionID)
      if (!list?.some((entry) => entry.id === id)) return false
      const next = list.filter((entry) => entry.id !== id)
      if (next.length === 0) data.delete(sessionID)
      else data.set(sessionID, next)
      return true
    })

    const remove = Effect.fn("SessionHooks.remove")((sessionID: SessionID, id: string) =>
      claim(sessionID, id).pipe(Effect.asVoid),
    )

    const list = Effect.fn("SessionHooks.list")(function* (sessionID: SessionID, event: HookEvent) {
      const data = yield* InstanceState.get(state)
      const arr = data.get(sessionID) ?? []
      return arr.filter((e) => e.event === event) as readonly SessionHookEntry[]
    })

    const listAll = Effect.fn("SessionHooks.listAll")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return (data.get(sessionID) ?? []) as readonly SessionHookEntry[]
    })

    const hasForEvent = Effect.fn("SessionHooks.hasForEvent")(function* (sessionID: SessionID, event: HookEvent) {
      const data = yield* InstanceState.get(state)
      const arr = data.get(sessionID)
      if (!arr || arr.length === 0) return false
      return arr.some((e) => e.event === event)
    })

    const clear = Effect.fn("SessionHooks.clear")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.delete(sessionID)
    })

    return Service.of({ add, claim, remove, list, listAll, hasForEvent, clear })
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make(layer, [])

// Re-export HookJSONOutput so consumers building entries don't need a second import.
export type { HookJSONOutput }

export * as SessionHooks from "./session-hooks"
