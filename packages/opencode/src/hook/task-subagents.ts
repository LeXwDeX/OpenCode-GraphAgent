/**
 * Process-local registry of child sessions currently driven in the foreground by
 * the task tool. task.ts fires `SubagentStop` (and drives its continuation) for
 * those sessions, so the child's prompt loop must not also fire the main-agent
 * `Stop` / `StopFailure` hooks. Every other child session (SDK-created
 * `POST /session {parentID}`, DAG nodes, background tasks) keeps firing Stop.
 *
 * Entries are reference-counted and released by the task tool's finalizer, so
 * the registry never outlives the task call that populated it.
 */
import { Effect } from "effect"

const active = new Map<string, number>()

/** True while a foreground task-tool call owns this session's SubagentStop. */
export function has(sessionID: string): boolean {
  return (active.get(sessionID) ?? 0) > 0
}

/** Register `sessionID`; yields an effect that releases this registration (idempotent). */
export function register(sessionID: string): Effect.Effect<Effect.Effect<void>> {
  return Effect.sync(() => {
    active.set(sessionID, (active.get(sessionID) ?? 0) + 1)
    let released = false
    return Effect.sync(() => {
      if (released) return
      released = true
      const count = (active.get(sessionID) ?? 0) - 1
      if (count > 0) active.set(sessionID, count)
      else active.delete(sessionID)
    })
  })
}

export * as TaskSubagents from "./task-subagents"
