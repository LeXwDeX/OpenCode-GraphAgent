/**
 * Cycle-free home for the `TriggerResult` type and the `landSystemMessages`
 * pure helper.
 *
 * `settings.ts` is a heavy module — its construction pulls in Provider →
 * Plugin → Session, which closes a load-order-sensitive cycle when imported
 * at the top of a Session-layer file (the resulting TDZ ReferenceError breaks
 * `test/goal` and `test/hook` independently). Consumers that only need the
 * result shape or the systemMessage landing helper MUST import from here
 * rather than from `settings.ts`; `settings.ts` re-exports both for backward
 * compatibility with existing import paths.
 *
 * This module depends on `effect` only — no provider/plugin/session edges —
 * so it is safe to import from anywhere.
 */
import { Effect } from "effect"

export interface TriggerResult {
  /** additionalContext strings appended (deduplicated per session) */
  additionalContexts: string[]
  /** systemMessage strings emitted by hooks */
  systemMessages: string[]
  /** Block decision — non-undefined means main flow must short-circuit */
  blocked?: { reason: string; command: string }
  /** continue=false from any hook */
  preventContinuation?: boolean
  /** stopReason aggregated from hooks that requested non-continuation */
  stopReason?: string
  /** Permission verdict (PreToolUse only meaningful) */
  permissionDecision?: "allow" | "deny" | "ask"
  permissionDecisionReason?: string
  /** Last hook's updatedInput wins (CC behavior) */
  updatedInput?: Record<string, unknown>
}

/** Post hooks run after the side effect; report validation feedback to the model. */
export function postHookFeedback(result: TriggerResult): string {
  return [
    ...(result.additionalContexts ?? []),
    ...(result.systemMessages ?? []),
    ...(result.blocked ? [`[Post-tool hook blocked] ${result.blocked.reason}`] : []),
    ...(result.preventContinuation ? [`[Hook stopped] ${result.stopReason ?? "Hook requested stop"}`] : []),
  ].join("\n\n")
}

export function withHookFeedback(output: string, result: TriggerResult): string {
  const feedback = postHookFeedback(result)
  return feedback ? `${output}\n\n${feedback}` : output
}

export function withHookFailure(error: unknown, result: TriggerResult): unknown {
  const feedback = postHookFeedback(result)
  if (!feedback) return error
  return new Error(`${error instanceof Error ? error.message : String(error)}\n\n${feedback}`, { cause: error })
}

/**
 * Land a TriggerResult's `systemMessages` so they are never silently dropped.
 *
 * Every systemMessage is logged (always-visible outlet). When `inject` is
 * provided, each message is also routed there (call sites with a session sink
 * use it to append a synthetic text part the model can see). Satisfies the
 * hooks-event-fidelity requirement that no systemMessage be discarded.
 */
export function landSystemMessages(
  result: TriggerResult,
  opts: { sessionID: string; inject?: (message: string) => Effect.Effect<unknown> },
): Effect.Effect<void> {
  const messages = result.systemMessages ?? []
  if (messages.length === 0) return Effect.void
  return Effect.gen(function* () {
    for (const message of messages) {
      yield* Effect.logInfo("hook systemMessage", { sessionID: opts.sessionID, systemMessage: message })
      if (opts.inject) yield* opts.inject(message)
    }
  })
}
