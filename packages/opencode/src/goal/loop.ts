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
import { SessionAutomationLease } from "@/session/automation-lease"

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GoalLoop") {}

/**
 * Test-only injection point for the judge LLM call. When provided in the
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
    state.turns_used === 0 &&
    !hasAssistant &&
    now - state.created_at > GoalPrompts.FRESHNESS_THRESHOLD
  )
}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const goal = yield* Goal.Service
    const status = yield* SessionStatus.Service
    const automation = yield* SessionAutomationLease.Service

    const pauseGoal = Effect.fnUntraced(function* (sessionID: SessionID, reason: string) {
      const paused = yield* goal.pauseAndPublish(sessionID, reason)
      if (paused)
        yield* automation.unregister(sessionID, { kind: "goal", id: paused.goal_id ?? "legacy" })
      return paused
    })

    // GOAL-FP-01-04 (D-1): the instance directory the scan scopes to. The
    // state builder runs under the ScopedCache layer-build environment,
    // which does NOT include InstanceRef in production — resolving
    // InstanceState.directory inside the builder would die with "InstanceRef
    // not provided". init resolves it from its CALLER's context (instance
    // boot provides InstanceRef) and hands it to the builder through this
    // ref, set BEFORE the first InstanceState.get so the builder always
    // reads a populated value.
    const scanDirectoryRef: { current: string } = { current: "" }

    const state = yield* InstanceState.make(
      Effect.fn("GoalLoop.state")(function* (ctx) {
        yield* events.subscribe(SessionStatus.Event.Status).pipe(
          Stream.filter((evt) => evt.data.status.type === "idle"),
          // D4 (fiber lifecycle): triggerEvaluation below carries the full
          // discipline (active-goal pre-check, fork, fiber registration,
          // identity-scoped self-clean), shared verbatim with the
          // GOAL-FP-01-04 startup scan so both drivers use one path.
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const sid = evt.data.sessionID
              // DAG-LOC-01 execution-location guard: idle Status events are
              // store-global. Only the instance whose DIRECTORY owns the
              // session may drive its goal loop — the real session-row check
              // (Goal.ownsSession reads SessionTable.directory; the workflow-
              // keyed DAG authority is vacuous for goal-only sessions, P2-A).
              // Sessions without a durable row are owned vacuously (synthetic
              // test sessions; a deleted session's goal state is gone with it).
              if (!(yield* Goal.ownsSession(sid, ctx.directory))) return
              yield* triggerEvaluation(sid)
              // P2-B subscription survival: this handler now contains the
              // first defect-capable durable reads in the goal idle path
              // (Goal.ownsSession / goal.load both orDie). Effect.ignore does
              // NOT absorb defects — a transient store failure would
              // permanently kill the runForEach subscription and the loop
              // would never evaluate another idle event. catchCause absorbs
              // failures AND defects at the boundary, so a store defect
              // degrades to a logged, skipped evaluation — never a dead loop.
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("GoalLoop idle handler failed", { sessionID: evt.data.sessionID, cause }),
              ),
            ),
          ),
          Effect.forkScoped,
        )
        // GOAL-FP-01-04: the startup resume scan. The durable snapshot is
        // captured HERE — at instance boot (the builder runs at the first
        // InstanceState.get, i.e. init), awaited — not inside the forked
        // scan fiber: a fiber delayed by scheduling could query AFTER this
        // process already evaluated a goal (the session's own idle event),
        // and re-evaluating that same turn boundary would double-commit
        // turns (the R1 turns-inflation harm). Querying at boot means only
        // goals that were active BEFORE this process started are ever
        // scanned. The builder context is also the layer-build context — the
        // one the idle subscription above sees — so the scan's evaluation
        // fibers resolve the same services.
        //
        // D-2: catchCause (unlike tapError/orElseSucceed) catches Fail AND
        // Defect, so ANY query failure degrades to no-scan + a log and can
        // never kill the builder — which would close the ScopedCache entry
        // scope and take the idle subscription down with it.
        //
        // S-2: defensive read. The ref being set before the first state get
        // is an invariant of the init→builder chain, not of the type system —
        // if any future path builds this state without init setting the ref
        // first, scanning with the empty value would silently match no
        // session (a quiet no-op that looks healthy). Fail LOUD instead:
        // log an error and skip the scan. The idle subscription above stays
        // armed either way, so the event-driven path is unaffected.
        if (!scanDirectoryRef.current) {
          yield* Effect.logError(
            "goal startup scan skipped: instance directory not resolved before state build",
          )
          return {}
        }
        const snapshot = yield* goal.listActiveSessions(scanDirectoryRef.current).pipe(
          Effect.catchCause((cause) => {
            const empty: ReadonlyArray<SessionID> = []
            return Effect.logWarning("goal startup scan query failed", {
              directory: scanDirectoryRef.current,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(empty))
          }),
        )
        // The per-session triggers are forked after the subscription is
        // armed and into the same scope; failures are logged, never fatal to
        // init.
        yield* scanForActiveGoals(snapshot).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("goal startup scan failed", { cause: Cause.pretty(cause) }),
          ),
          Effect.forkScoped,
        )
        return {}
      }),
    )

    // D-4 (GOAL-FP-01-04 follow-up): per-process record of which goal
    // revision this process already evaluated. Written by afterIdle on every
    // successful updateAfterJudge commit; consulted ONLY by the startup-scan
    // path (scanResume) — the idle path must keep re-evaluating the same
    // revision across new turn boundaries, so the gate never applies to it.
    // Lifecycle mirrors the fibers map: overwritten by every commit, deleted
    // at the same terminal points where afterIdle unregisters the goal
    // automation.
    const evaluatedRevisions = new Map<SessionID, number>()

    const afterIdle = Effect.fn("GoalLoop.afterIdle")(function* (sessionID: SessionID, scanResume?: boolean) {
      // GOAL-TURN-SCOPE: the goal-driven turn that produced this idle has
      // ended. Clear the mark up front; the continuation branch below re-marks
      // when it dispatches the next turn. This also retires a stale mark when
      // the idle came from an unrelated (non-goal) turn.
      yield* goal.clearTurnDriven(sessionID)
      const goalState = yield* goal.load(sessionID)
      if (!goalState || goalState.status !== "active") return
      // D-4 entry gate (scan path only): the boot snapshot may have gone
      // stale between triggerEvaluation's load and this entry load — an idle
      // evaluation could have committed a new revision in between, and this
      // scan evaluation would then double-commit the SAME boundary
      // (matchesExpected passes because this entry load already sees the
      // newer revision). If this process already evaluated the CURRENT
      // revision, the scan trigger is stale — skip.
      if (scanResume && evaluatedRevisions.get(sessionID) === (goalState.revision ?? 0)) return
      const goalOwner = { kind: "goal" as const, id: goalState.goal_id ?? "legacy" }
      yield* automation.register(sessionID, goalOwner)
      const observedLease = Option.getOrUndefined(yield* automation.claim(sessionID, goalOwner))
      if (!observedLease) return

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
        goalState.turns_used === 0 &&
        Date.now() - goalState.created_at > GoalPrompts.FRESHNESS_THRESHOLD
      ) {
        const probeMsgs = yield* sessions.messages({ sessionID, limit: 1 })
        const hasAssistant = probeMsgs.some((m) => m.info.role === "assistant")
        if (isStaleZombie(goalState, hasAssistant)) {
          yield* pauseGoal(
              sessionID,
              `initial kick produced no assistant response within ${GoalPrompts.FRESHNESS_THRESHOLD / 1000}s — likely provider error or model refusal. Use /goal resume to retry.`,
            ).pipe(Effect.ignore)
          return
        }
      }

      const msgs = yield* sessions.messages({ sessionID, limit: 20 })
      const lastAssistant = [...msgs].reverse().find((m) => m.info.role === "assistant")
      if (!lastAssistant) {
        // No assistant message in the last 20 — the conversation may have
        // been compacted or the initial kick failed after the stale-zombie
        // guard window. Pause visibly instead of silently stalling.
        const pauseMsg = "近期消息中无 assistant 回复，目标已暂停。使用 /goal resume 重试。"
        yield* pauseGoal(sessionID, pauseMsg).pipe(Effect.ignore)
        yield* promptSvc.prompt({ sessionID, noReply: true, parts: [{ type: "text", text: `⏸ 目标已暂停 — ${pauseMsg}` }] }).pipe(Effect.ignore)
        return
      }
      const responseText = lastAssistant.parts
        .filter((p): p is Extract<(typeof lastAssistant.parts)[number], { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .slice(-4000)
      // When the last assistant turn produced no text (pure tool calls,
      // reasoning-only, or a submit_result with no prose), the goal should
      // NOT silently stall — the agent is making progress via tools. Skip
      // the judge (there is nothing to classify) and continue directly,
      // using a synthetic "continue" verdict so the loop dispatches the
      // next turn. Previously this was a bare `return` that left the goal
      // permanently "active" with no continuation — the agent appeared to
      // stop working on its own.
      const callLLM = Option.getOrUndefined(yield* Effect.serviceOption(GoalLoopJudgeLLM))
      const verdict = responseText
        ? yield* GoalJudge.run(
            goalState.goal,
            responseText,
            goalState.subgoals ?? [],
            // Judge LLM call: prefer the test-injected callable so e2e tests
            // can script verdicts without Provider/network; otherwise build the
            // production Provider → generateText path.
            callLLM?.call ??
              ((opts) =>
                Effect.gen(function* () {
                  const defaultM = yield* provider.defaultModel()
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
                    catch: (e) => new Error(`judge LLM call failed: ${String(e)}`),
                  }).pipe(Effect.timeout(`${opts.timeout} seconds`))
                  if (!result) return ""
                  return result.text
                })),
          )
        : { verdict: "continue" as const, reason: "上一轮无文本输出（纯工具调用），跳过判定直接继续", parseFailed: false }

      const updateResult = Option.getOrUndefined(
        yield* automation.use(
          observedLease,
          goal.updateAfterJudge(
            sessionID,
            verdict.verdict,
            verdict.reason,
            verdict.parseFailed,
            {
              goalID: goalState.goal_id ?? "legacy",
              revision: goalState.revision ?? 0,
            },
          ),
        ),
      )
      if (!updateResult) return

      // D-4: record the committed revision as evaluated-by-this-process
      // (every verdict — continue, done, blocked — is a completed
      // evaluation of the pre-commit state).
      evaluatedRevisions.set(sessionID, updateResult.state.revision ?? 0)

      if (!updateResult.shouldContinue) {
        yield* automation.unregister(sessionID, goalOwner)
        evaluatedRevisions.delete(sessionID)
        if (verdict.verdict === "done") {
          // GOAL-FP-01-15: the done transition has already committed when this
          // prompt runs (durable state leads presentation — the row is gone
          // and goal.updated(done)/goal.cleared are published), so a failure
          // here loses only the transcript line, never the state. Never
          // swallow it silently — log it so a lost confirmation is
          // diagnosable. No retry: a retried prompt could re-inject a "done"
          // line after the goal was re-created.
          yield* promptSvc.prompt({
            sessionID,
            noReply: true,
            parts: [{ type: "text", text: updateResult.message }],
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("goal done message delivery failed", {
                sessionID,
                cause: Cause.pretty(cause),
              }),
            ),
          )
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
        // Session is no longer idle after the judge call (5-30s latency).
        // Previously this was a bare `return` that left the goal silently
        // "active" with no continuation. Pause with a visible reason so the
        // user knows the loop was interrupted by a status change.
        const pauseMsg = `judge 期间会话状态变化（${currentStatus.type}），目标已暂停`
        yield* pauseGoal(sessionID, pauseMsg).pipe(Effect.ignore)
        yield* promptSvc.prompt({ sessionID, noReply: true, parts: [{ type: "text", text: `⏸ 目标已暂停 — ${pauseMsg}` }] }).pipe(Effect.ignore)
        return
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
        yield* pauseGoal(sessionID, "当前轮被中断").pipe(Effect.ignore) // user preempted
        return
      }

      const reloadedState = yield* goal.load(sessionID)
      if (!reloadedState || reloadedState.status !== "active") return

      // Single merged continuation injection. This replaces the former
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
        turnsUsed: reloadedState.turns_used,
        maxTurns: reloadedState.max_turns,
        lastJudgeReason: reloadedState.last_reason,
      })

      // Continuation dispatch can fail (provider fault, session write error,
      // …). Previously the error escaped to the fork-point Effect.ignore and
      // was swallowed, leaving the goal silently `active` with no idle event
      // to drive the next turn — a permanent, invisible stall. Catch the full
      // cause (recoverable failures + defects) and transition to a recoverable
      // paused state via the fiber-safe pauseAndPublish (goal.pause would
      // clearFiber — us — mid-publish; see the preempt branches above).
      const continuationLease = Option.getOrUndefined(yield* automation.claim(sessionID, goalOwner))
      if (!continuationLease) return
      yield* Effect.gen(function* () {
        // GOAL-TURN-SCOPE: mark BEFORE admission so the goal-turn provenance is
        // already visible the instant the continuation can start — no window
        // where an httpapi cancel slips between admit and mark. If admission
        // is refused (session not idle), clear the speculative mark.
        yield* goal.markTurnDriven(sessionID)
        const admitted = yield* SessionPrompt.admitIfIdle(promptSvc, automation, continuationLease, {
          sessionID,
          parts: [{ type: "text", text: continuationText }],
        })
        if (Option.isNone(admitted)) {
          yield* goal.clearTurnDriven(sessionID)
          return
        }
        yield* admitted.value
      }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              // F1: Only pause for non-interrupt causes. An interrupt (user
              // pressed ESC during continuation) is safe to drop because
              // SessionPrompt.cancel pauses goal-driven turns SYNCHRONOUSLY via
              // goal.pauseForUserCancel (prompt.ts) BEFORE state.cancel lets the
              // interrupt propagate — by the time this catchCause observes the
              // cause, the goal is already paused, and pausing again HERE would
              // double-publish. The session still ALWAYS re-emits idle
              // afterwards, which re-drives this loop: SessionRunState.cancel
              // (run-state.ts) and the runner's onIdle callback both call
              // status.set(idle), and SessionStatus.set (status.ts) publishes
              // the Status+Idle event pair unconditionally — even when the
              // session was already idle. On that next cycle shouldPreempt is
              // only the DB-failure fallback for a pauseForUserCancel that could
              // not persist. Real dispatch failures (provider fault, session
              // write error) still get the recoverable pause below.
              // F1: hasInterrupts is a structural check; Cause.interruptors only
              // collects DEFINED fiber ids and silently ignores interrupts
              // carrying none (e.g. Cause.interrupt()), which would otherwise be
              // misclassified as a dispatch failure and spuriously paused here.
              if (Cause.hasInterrupts(cause)) {
                yield* Effect.logInfo("goal continuation interrupted (likely user ESC) — not pausing; cancel path already paused the goal")
                return Option.none()
              }
              const errMsg = `continuation dispatch failed: ${Cause.pretty(cause)}`
              yield* Effect.logWarning("goal continuation dispatch failed", { error: Cause.pretty(cause) })
              // GOAL-FP-01-12: symmetric with every other pause site — the
              // unregister must be part of the failure transition, not
              // deferred to the trailing afterDispatch load (which a defect or
              // a concurrent replacement can skip, leaking the registration
              // until /goal clear). pauseGoal keeps the fiber-safe
              // pauseAndPublish (goal.pause would clearFiber — us —
              // mid-publish) and releases the lease registration inline.
              yield* pauseGoal(sessionID, errMsg).pipe(Effect.ignore)
              yield* promptSvc.prompt({ sessionID, noReply: true, parts: [{ type: "text", text: `⏸ 目标已暂停 — ${errMsg}` }] }).pipe(Effect.ignore)
              return Option.none()
            }),
          ),
      )
      const afterDispatch = yield* goal.load(sessionID)
      if (!afterDispatch || afterDispatch.status !== "active") {
        yield* automation.unregister(sessionID, goalOwner)
        evaluatedRevisions.delete(sessionID)
      }

      // NOTE: We deliberately DO NOT call goal.clearLoopFiber here. The
      // promptSvc.prompt above triggers a fresh agent loop, which when it
      // goes idle will cause the SessionStatus idle subscription to fork
      // a NEW afterIdle fiber and registerLoopFiber will auto-override the
      // (naturally completed) current fiber in the map. An explicit
      // clearLoopFiber from within ourselves would race with that override
      // and could interrupt the newly registered fiber C, silently
      // stalling the goal loop.
    })

    // Shared evaluation trigger for BOTH the idle-event subscription above
    // and the GOAL-FP-01-04 startup scan below — no second evaluation path.
    //
    // D4 (fiber lifecycle): do NOT fork or register a fiber for sessions
    // without an active goal. Without this pre-check the fibers Map grows
    // once per idle event for every session that ever went idle — including
    // ones that never set a goal. afterIdle re-checks goal state internally
    // too; that internal check stays as a TOCTOU guard (goal could be cleared
    // between this load and the fork). v1.17.11: idle has no cause field;
    // afterIdle handles abort detection via shouldPreempt (user message after
    // cancel).
    //
    // D4 self-clean: when the afterIdle fiber completes naturally, remove it
    // from the fibers Map IF it is still the registered one. A newer idle
    // event may have already registered a fresh fiber (registerLoopFiber
    // interrupts + overwrites the old one); clearLoopFiberIf's identity check
    // avoids evicting the new fiber. The watcher never interrupts and
    // completes right after its target, so it does not accumulate.
    const triggerEvaluation = Effect.fnUntraced(function* (sessionID: SessionID, scanResume?: boolean) {
      const scope = yield* Scope.Scope
      const goalState = yield* goal.load(sessionID)
      if (!goalState || goalState.status !== "active") return
      // D-4 gate (scan path only): skip when this process already evaluated
      // the CURRENT revision — the boot snapshot went stale after a
      // legitimate evaluation (e.g. the session's own idle event ran before
      // the scan fiber). This replaces the boot-snapshot revision
      // comparison: unlike that gate, a revision bumped by a non-evaluation
      // touch (pause/resume/subgoal edit — including one made by another
      // process before this boot) does NOT suppress the resume, which is
      // correct — the goal still awaits its evaluation. The idle
      // subscription never passes scanResume, so this only narrows the scan.
      // afterIdle re-checks at its own entry load (see there) to close the
      // window between this load and the fork.
      if (scanResume && evaluatedRevisions.get(sessionID) === (goalState.revision ?? 0)) return
      const fiber = yield* afterIdle(sessionID, scanResume).pipe(Effect.ignore, Effect.forkIn(scope))
      yield* goal.registerLoopFiber(sessionID, fiber)
      yield* Fiber.await(fiber).pipe(
        Effect.flatMap(() => goal.clearLoopFiberIf(sessionID, fiber)),
        Effect.ignore,
        Effect.forkIn(scope),
      )
    })

    // GOAL-FP-01-04: startup resume scan. GoalLoop is purely event-driven —
    // the idle subscription above is the only driver, and no component emits
    // idle for sessions that already existed at startup. An active goal that
    // survived a crash therefore sleeps until the next user interaction (the
    // D6 zombie guard also never fires: it runs inside afterIdle). The scan
    // restores the automation obligation: for each session in the boot
    // snapshot, trigger the EXISTING idle evaluation path.
    //
    // - Mutual exclusion: the lease claim is the sole authority. A session
    //   whose owner is dag is rejected by claim inside afterIdle exactly as
    //   on a real idle, and the blocked-claim re-trigger (GOAL-FP-01-02)
    //   re-evaluates it once the dag releases — the rejected trigger is
    //   harmless and self-healing.
    // - Busy sessions: the SessionStatus gate below mirrors the
    //   automation-lease re-trigger gate; a session mid-turn is skipped and
    //   will be driven by its own turn-end idle event. At startup the status
    //   map is empty (get defaults to idle), so this only filters sessions
    //   that genuinely flipped busy between bootstrap and the scan.
    // - Crash window (query → trigger): terminal changes are absorbed by the
    //   active-status re-check; non-terminal changes (already evaluated in
    //   this process) by the D-4 record gate in triggerEvaluation/afterIdle.
    // - Failures: per-session catchCause (covers Fail AND Defect) so one bad
    //   session never kills the rest of the scan; the whole scan is forked,
    //   so a failure can never kill init.
    const scanForActiveGoals = Effect.fnUntraced(function* (snapshot: ReadonlyArray<SessionID>) {
      for (const sessionID of snapshot) {
        const current = yield* status.get(sessionID)
        if (current.type !== "idle") continue
        yield* triggerEvaluation(sessionID, true).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("goal startup scan failed for session", {
              sessionID,
              cause: Cause.pretty(cause),
            }),
          ),
        )
      }
    })

    const init = Effect.fn("GoalLoop.init")(function* () {
      // Resolve the scan's directory scope BEFORE the first state get — the
      // builder (which runs inside that get) reads it from the ref. This
      // context carries InstanceRef (instance boot provides it); the
      // builder's does not.
      scanDirectoryRef.current = yield* InstanceState.directory
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

export const layer = serviceLayer.pipe(Layer.provide(SessionAutomationLease.defaultLayer))

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
