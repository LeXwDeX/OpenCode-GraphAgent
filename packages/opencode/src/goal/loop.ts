export * as GoalLoop from "./loop"

import { Effect, Layer, Context, Option, Stream, Scope, Fiber, Cause } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { Goal } from "./goal"
import { GoalJudge } from "./judge"
import { GoalPrompts } from "./prompts"
import { generateText } from "ai"
import { SessionID } from "@/session/schema"

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GoalLoop") {}

/**
 * Test-only injection point for the judge LLM call (D5). When provided in the
 * Effect context, `afterIdle` uses `call` instead of the production
 * Provider → generateText path, so e2e tests can script judge verdicts
 * (continue→done) with no network or Provider credentials. Production never
 * provides it, so the Provider path is byte-for-byte unchanged.
 */
export type JudgeCallLLM = (opts: {
  system: string
  user: string
  temperature: number
  maxTokens: number
  timeout: number
}) => Effect.Effect<string, Error>

export interface GoalLoopJudgeLLMInterface {
  readonly call: JudgeCallLLM
}

export class GoalLoopJudgeLLM extends Context.Service<GoalLoopJudgeLLM, GoalLoopJudgeLLMInterface>()(
  "@opencode/GoalLoop/JudgeLLM",
) {}

/**
 * Pure predicate: returns true when the most recent user message in `msgs`
 * is newer than the most recent assistant message.
 *
 * Used by GoalLoop.afterIdle as a strict-preempt guard: if the user has
 * inserted a new turn after the last assistant response, we must abandon
 * the pending continuation and pause the goal instead of re-prompting.
 *
 * Defensive fallback: if either side is missing, returns false (no preempt).
 *
 * Operates on MessageV2 shape (`info.time.created`).
 */
export function shouldPreempt(
  msgs: ReadonlyArray<{ info: { role: "user" | "assistant"; time: { created: number } } }>,
): boolean {
  let lastUserAt = -1
  let lastAsstAt = -1
  for (const m of msgs) {
    const t = m.info.time?.created
    if (typeof t !== "number") continue
    if (m.info.role === "user" && t > lastUserAt) lastUserAt = t
    else if (m.info.role === "assistant" && t > lastAsstAt) lastAsstAt = t
  }
  if (lastUserAt < 0 || lastAsstAt < 0) return false
  return lastUserAt > lastAsstAt
}

/**
 * Pure predicate for the zombie-goal freshness guard (D6). Returns true when a
 * goal is "orphaned": active, has run zero continuations (turns_used === 0),
 * was created more than FRESHNESS_THRESHOLD ago, and the initial kick never
 * produced an assistant message (provider error, model refusal, empty response).
 *
 * Used by GoalLoop.afterIdle to convert the silent orphan state into a visible,
 * recoverable pause. Without it, every subsequent afterIdle would abort at the
 * `if (!lastAssistant) return` line and the goal would sit permanently "active"
 * with no progress.
 *
 * `now` defaults to Date.now() for production; tests pass an explicit value for
 * determinism.
 */
export function isStaleZombie(
  state: { status: string; turns_used: number; created_at: number },
  hasAssistant: boolean,
  now: number = Date.now(),
): boolean {
  return (
    state.status === "active" &&
    Number(state.turns_used) === 0 &&
    !hasAssistant &&
    now - state.created_at > GoalPrompts.FRESHNESS_THRESHOLD
  )
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const goal = yield* Goal.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("GoalLoop.state")(function* (_ctx) {
        const scope = yield* Scope.Scope
        yield* events.subscribe(SessionStatus.Event.Status).pipe(
          Stream.filter((evt) => evt.data.status.type === "idle"),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const sid = evt.data.sessionID
              // D4 (fiber lifecycle): do NOT fork or register a fiber for
              // sessions without an active goal. Without this pre-check the
              // fibers Map grows once per idle event for every session that
              // ever went idle — including ones that never set a goal. afterIdle
              // re-checks goal state internally too; that internal check stays
              // as a TOCTOU guard (goal could be cleared between this load and
              // the fork). v1.17.11: idle has no cause field; afterIdle handles
              // abort detection via shouldPreempt (user message after cancel).
              const goalState = yield* goal.load(sid)
              if (!goalState || goalState.status !== "active") return
              const fiber = yield* afterIdle(sid).pipe(Effect.ignore, Effect.forkIn(scope))
              yield* goal.registerLoopFiber(sid, fiber)
              // D4 self-clean: when this afterIdle fiber completes naturally,
              // remove it from the fibers Map IF it is still the registered one.
              // A newer idle event may have already registered a fresh fiber
              // (registerLoopFiber interrupts + overwrites the old one);
              // clearLoopFiberIf's identity check avoids evicting the new fiber.
              // The watcher never interrupts and completes right after its
              // target, so it does not accumulate across idle events.
              yield* Fiber.await(fiber).pipe(
                Effect.flatMap(() => goal.clearLoopFiberIf(sid, fiber)),
                Effect.ignore,
                Effect.forkIn(scope),
              )
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        )
        return {}
      }),
    )

    const afterIdle = Effect.fn("GoalLoop.afterIdle")(function* (sessionID: SessionID) {
      const goalState = yield* goal.load(sessionID)
      if (!goalState || goalState.status !== "active") return

      // Zombie-goal freshness guard (D6). If the goal is active but has run
      // zero continuations and is older than FRESHNESS_THRESHOLD, the initial
      // kick may have failed silently (provider error, model refusal, empty
      // response). Without this guard every subsequent afterIdle aborts at the
      // `if (!lastAssistant) return` line below, leaving the goal permanently
      // "active" with no progress — a silent orphan. Convert that into a
      // visible, recoverable pause so the user can /goal resume.
      //
      // The probe loads only 1 message (not the full 20) so we don't pay for
      // the whole message window just to discover staleness; the stale path
      // returns early so the limit:20 load below never runs when the guard
      // fires. Uses pauseAndPublish (fiber-safe) — NOT goal.pause — because
      // we ARE the loop fiber tracked in the fibers map (same self-interrupt
      // hazard discipline as the done / shouldPreempt branches below).
      if (
        Number(goalState.turns_used) === 0 &&
        Date.now() - goalState.created_at > GoalPrompts.FRESHNESS_THRESHOLD
      ) {
        const probeMsgs = yield* sessions.messages({ sessionID, limit: 1 })
        const hasAssistant = probeMsgs.some((m) => m.info.role === "assistant")
        if (isStaleZombie(goalState, hasAssistant)) {
          yield* goal
            .pauseAndPublish(
              sessionID,
              `initial kick produced no assistant response within ${GoalPrompts.FRESHNESS_THRESHOLD / 1000}s — likely provider error or model refusal. Use /goal resume to retry.`,
            )
            .pipe(Effect.ignore)
          return
        }
      }

      const msgs = yield* sessions.messages({ sessionID, limit: 20 })
      const lastAssistant = [...msgs].reverse().find((m) => m.info.role === "assistant")
      if (!lastAssistant) return
      const responseText = lastAssistant.parts
        .filter((p): p is Extract<(typeof lastAssistant.parts)[number], { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .slice(-4000)
      if (!responseText) return

      // Judge LLM call: prefer the test-injected callable (D5) so e2e tests
      // can script verdicts without Provider/network; otherwise build the
      // production Provider → generateText path. The verdict logic below is
      // unchanged — only the callLLM construction point moved.
      const injected = Option.getOrUndefined(yield* Effect.serviceOption(GoalLoopJudgeLLM))
      const callLLM: JudgeCallLLM =
        injected?.call ??
        ((opts) =>
          Effect.gen(function* () {
            const defaultM = yield* provider.defaultModel()
            // Judge is a ~200-token JSON binary classification — prefer the
            // provider's small/fast model (config `small_model`, plugin hint,
            // or the built-in haiku/flash/nano priority list). Fall back to
            // the default model when no small model is resolvable, keeping
            // the prior behavior byte-for-byte for those providers.
            const small = yield* provider.getSmallModel(defaultM.providerID)
            const model = small ?? (yield* provider.getModel(defaultM.providerID, defaultM.modelID))
            const language = yield* provider.getLanguage(model)
            const result = yield* Effect.tryPromise({
              try: (signal) =>
                generateText({
                  model: language,
                  system: opts.system,
                  prompt: opts.user,
                  temperature: opts.temperature,
                  maxOutputTokens: opts.maxTokens,
                  abortSignal: signal,
                }),
              catch: (e) => new Error(`judge LLM call failed: ${e}`),
            }).pipe(Effect.timeout(`${opts.timeout} seconds`))
            if (!result) return ""
            return result.text
          }))

      const verdict = yield* GoalJudge.run(
        goalState.goal,
        responseText,
        goalState.subgoals ?? [],
        callLLM,
      )

      const updateResult = yield* goal.updateAfterJudge(sessionID, verdict.verdict, verdict.reason, verdict.parseFailed)
      if (!updateResult) return

      if (!updateResult.shouldContinue) {
        // Inject visible completion message when goal is achieved, then
        // auto-clear the goal state. `updateAfterJudge` already persisted
        // a done snapshot and published goal.updated — that snapshot is
        // only kept long enough to emit the completion message, then the
        // row is removed so done is a transient visual-only state (mirrors
        // how /goal clear behaves). This is what makes goal completion
        // not require a manual /goal clear afterwards.
        if (verdict.verdict === "done") {
          // Run the terminal event sequence FIRST (F1): publish(done) →
          // delete → publish(cleared) is the contract SSE/TUI consumers
          // rely on, so it must complete before any other effect that could
          // race the loop fiber. deleteAndPublishDone is uninterruptible and
          // fiber-safe (no clearFiber), so this ordering is pure
          // defense-in-depth — the completion message text is computed from
          // updateResult.message (pre-deletion state) and is unaffected by
          // running after the delete. The noReply path returns before any
          // status transition today, but completing the terminal sequence
          // first makes the contract structurally enforced rather than
          // dependent on that noReply implementation detail.
          yield* goal.deleteAndPublishDone(sessionID, verdict.reason).pipe(Effect.ignore)
          yield* promptSvc.prompt({
            sessionID,
            noReply: true,
            parts: [{ type: "text", text: updateResult.message }],
          }).pipe(Effect.ignore)
        } else {
          // Auto-pause branch: updateAfterJudge paused the goal due to
          // judge-parse-failure or budget exhaustion (verdict.verdict is
          // still "continue"). Without surfacing the message here, these
          // automatic pauses would be invisible to the user — updateAfterJudge
          // already saved the paused state and published goal.updated, but
          // nothing rendered the "⏸ 目标已暂停 — …" line into the transcript.
          // Emit it as a noReply part so it shows up without spawning a new
          // agent turn; the fiber then naturally terminates (no clearFiber
          // needed, see updateAfterJudge).
          yield* promptSvc.prompt({
            sessionID,
            noReply: true,
            parts: [{ type: "text", text: updateResult.message }],
          }).pipe(Effect.ignore)
        }
        return
      }

      const currentStatus = yield* status.get(sessionID)
      if (currentStatus.type !== "idle") {
        return // session no longer idle, skip continuation
      }

      // Reload messages after judge LLM call — the snapshot from before judge
      // may be stale if user sent messages during the 5-30s judge latency
      const freshMsgs = yield* sessions.messages({ sessionID, limit: 20 })

      if (shouldPreempt(freshMsgs)) {
        // Same self-interrupt hazard as the done branch above: we ARE the
        // fiber tracked in the fibers map, so goal.pause() (which internally
        // calls clearFiber) would interrupt ourselves before
        // publishGoal(paused) reaches the event bus. Use pauseAndPublish
        // which skips fiber management — the fiber naturally terminates
        // when this function returns.
        yield* goal.pauseAndPublish(sessionID, "当前轮被中断").pipe(Effect.ignore) // user preempted
        return
      }

      const reloadedState = yield* goal.load(sessionID)
      if (!reloadedState || reloadedState.status !== "active") return

      // Single merged continuation injection (D4.2). This replaces the former
      // two-call sequence (a `noReply` progress line + an `ignored:true`
      // continuation). The merged prompt carries goal text, subgoals, the
      // turns/budget line, and the last judge reason, plus the autonomous-mode
      // frame — and it is BOTH the user-visible per-turn progress line AND the
      // prompt that drives the next agent turn.
      //
      // It is deliberately a plain text part: no `noReply` (so it spawns the
      // next agent turn) and no `ignored` (so it renders in the transcript AND
      // reaches the model — `ignored:true` text parts are filtered out of model
      // messages in MessageV2.toModelMessagesEffect). Driving + visibility +
      // model-reachability are all required by D4.2.
      const continuationText = GoalPrompts.renderContinuation({
        goal: reloadedState.goal,
        subgoals: reloadedState.subgoals ?? [],
        turnsUsed: Number(reloadedState.turns_used),
        maxTurns: Number(reloadedState.max_turns),
        lastJudgeReason: reloadedState.last_reason,
      })

      // Continuation dispatch can fail (provider fault, session write error,
      // …). Previously the error escaped to the fork-point Effect.ignore and
      // was swallowed, leaving the goal silently `active` with no idle event
      // to drive the next turn — a permanent, invisible stall. Catch the full
      // cause (recoverable failures + defects) and transition to a recoverable
      // paused state via the fiber-safe pauseAndPublish (goal.pause would
      // clearFiber — us — mid-publish; see the preempt branches above).
      yield* promptSvc
        .prompt({
          sessionID,
          parts: [{ type: "text", text: continuationText }],
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("goal continuation dispatch failed", { error: Cause.pretty(cause) })
              yield* goal.pauseAndPublish(sessionID, `continuation dispatch failed: ${Cause.pretty(cause)}`).pipe(
                Effect.ignore,
              )
            }),
          ),
        )

      // NOTE: We deliberately DO NOT call goal.clearLoopFiber here. The
      // promptSvc.prompt above triggers a fresh agent loop, which when it
      // goes idle will cause the SessionStatus idle subscription to fork
      // a NEW afterIdle fiber and registerLoopFiber will auto-override the
      // (naturally completed) current fiber in the map. An explicit
      // clearLoopFiber from within ourselves would race with that override
      // and could interrupt the newly registered fiber C, silently
      // stalling the goal loop.
    })

    const init = Effect.fn("GoalLoop.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

// GoalLoop.defaultLayer self-provides its construction deps. Because
// Layer.provideMerge(self, layer) requires `layer` (GoalLoop) to be
// self-contained — self's context is NOT fed into layer — every dep in the
// chain must be provided here, transitively. memoMap dedups these with the
// AppLayer's own instances so no duplicate services are created.
export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Goal.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

export const node = LayerNode.make(layer, [
  EventV2Bridge.node,
  Session.node,
  SessionPrompt.node,
  Provider.node,
  Goal.node,
  SessionStatus.node,
])
