export * as Goal from "./goal"

import { Effect, Layer, Context, Schema, Fiber } from "effect"
import { desc, eq, sql } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GoalState } from "./state"
import { GoalOutcomeTable, GoalStateTable } from "@opencode-ai/core/goal/sql"
import { GoalEvent } from "./events"
import { GoalPrompts } from "./prompts"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionAutomationLease } from "@/session/automation-lease"

export type RemoveSubgoalResult =
  | { tag: "ok"; removed: string; state: GoalState.Info }
  | { tag: "noState" }
  | { tag: "outOfBounds"; size: number }

export interface Interface {
  readonly load: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  /**
   * GOAL-FP-01-04: durable session ids whose goal_state row is still "active"
   * AND whose session belongs to `directory` — the startup-resume scan input
   * for GoalLoop.init. The session table is the directory authority
   * (goal_state has no directory column), so one instance's scan can never
   * drive another instance's goals. Best-effort: rows whose payload fails to
   * decode are skipped with a logged warning, not fatal.
   */
  readonly listActiveSessions: (directory: string) => Effect.Effect<ReadonlyArray<SessionID>, Error>
  readonly lastOutcome: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  readonly set: (sessionID: SessionID, goal: string, maxTurns?: number) => Effect.Effect<GoalState.Info>
  readonly pause: (sessionID: SessionID, reason: string) => Effect.Effect<GoalState.Info | undefined>
  readonly resume: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  /** Session-deletion cleanup: remove goal_state AND all goal_outcome rows. */
  readonly purgeSession: (sessionID: SessionID) => Effect.Effect<void>
  readonly markDone: (sessionID: SessionID, reason: string) => Effect.Effect<GoalState.Info | undefined>
  readonly addSubgoal: (sessionID: SessionID, subgoal: string) => Effect.Effect<GoalState.Info | undefined>
  readonly removeSubgoal: (
    sessionID: SessionID,
    /** 1-based index of the subgoal to remove (1 = first subgoal). */
    index: number,
  ) => Effect.Effect<RemoveSubgoalResult>
  readonly clearSubgoals: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  readonly statusLine: (sessionID: SessionID) => Effect.Effect<string | undefined>
  readonly dispatch: (sessionID: SessionID, args: string) => Effect.Effect<{
    type: "message" | "kick"
    text: string
    announce?: string
  }>
  readonly dispatchSubgoal: (sessionID: SessionID, args: string) => Effect.Effect<{
    type: "message"
    text: string
  }>
  readonly updateAfterJudge: (
    sessionID: SessionID,
    verdict: GoalState.Verdict,
    reason: string,
    parseFailed: boolean,
    expected?: { readonly goalID: string; readonly revision: number },
  ) => Effect.Effect<
    | {
        state: GoalState.Info
        shouldContinue: boolean
        message: string
      }
    | undefined
  >
    readonly registerLoopFiber: (sessionID: SessionID, fiber: Fiber.Fiber<unknown, unknown>) => Effect.Effect<void>
    readonly clearLoopFiber: (sessionID: SessionID) => Effect.Effect<void>
    /**
     * Identity-scoped loop-fiber cleanup. Removes the fibers-Map entry for
     * `sessionID` ONLY if it currently still points at `fiber` (a newer idle
     * event may have already registered a fresh fiber via registerLoopFiber,
     * which interrupts and overwrites). MUST NOT interrupt the fiber — callers
     * invoke this once the fiber has already completed its work (natural
     * completion via the GoalLoop idle watcher). Without the identity check, a
     * naturally-completing old fiber would evict a freshly-registered new fiber
     * and silently stall the goal loop.
     */
    readonly clearLoopFiberIf: (
      sessionID: SessionID,
      fiber: Fiber.Fiber<unknown, unknown>,
    ) => Effect.Effect<void>
    /**
     * Terminal cleanup for the "done" transition: publishes goal.updated(status=done)
     * with a transient snapshot, deletes the row, then publishes goal.cleared.
     *
     * Safe to call from ANY context — including inside the loop fiber itself
     * (loop.ts done branch) — because it does NOT manage the fiber map. Callers
     * that need to stop a running loop from outside (user slash commands,
     * goal.complete tool calls) should call `clearFiber()` FIRST, e.g. markDone.
     *
     * Constructing the done-state snapshot (instead of publishing the raw
     * row, whose status is still "active") preserves the documented bus
     * contract: goal.updated(done) → goal.cleared.
     */
    readonly deleteAndPublishDone: (sessionID: SessionID, reason: string) => Effect.Effect<GoalState.Info | undefined>
    /**
     * Pause transition that does NOT touch the fiber map. Mirrors
     * deleteAndPublishDone's safety property: safe to call from inside the
     * loop fiber (loop.ts shouldPreempt branch) because goal.pause()
     * internally calls clearFiber which would self-interrupt before
     * publishGoal(paused) reaches the event bus.
     *
     * Callers that need to stop a running loop from outside (user slash
     * commands) should call `pause()` instead — it interrupts the loop
     * fiber AND publishes the paused event.
     */
    readonly pauseAndPublish: (sessionID: SessionID, reason: string) => Effect.Effect<GoalState.Info | undefined>
  }

export class Service extends Context.Service<Service, Interface>()("@opencode/Goal") {}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    const sessionStatus = yield* SessionStatus.Service
    const automation = yield* SessionAutomationLease.Service

    // Unified event publisher — every state change publishes goal.updated
    // with the full snapshot, identical to Todo's todo.updated pattern.
    const publishGoal = (sessionID: SessionID, state: GoalState.Info) =>
      events.publish(GoalEvent.Updated, {
        sessionID,
        goal: {
          goal: state.goal,
          status: state.status,
          turnsUsed: state.turns_used,
          maxTurns: state.max_turns,
          subgoals: state.subgoals ?? [],
          ...(state.paused_reason !== undefined ? { pausedReason: state.paused_reason } : {}),
        },
      })

    const fibers = new Map<SessionID, Fiber.Fiber<unknown, unknown>>()

    const registerFiber = Effect.fnUntraced(function* (
      sessionID: SessionID,
      fiber: Fiber.Fiber<unknown, unknown>,
    ) {
      const existing = fibers.get(sessionID)
      if (existing) yield* Fiber.interrupt(existing)
      fibers.set(sessionID, fiber)
    })

    const clearFiber = Effect.fnUntraced(function* (sessionID: SessionID) {
      const existing = fibers.get(sessionID)
      if (existing) {
        yield* Fiber.interrupt(existing)
        fibers.delete(sessionID)
      }
    })

    // Identity-scoped self-clean for naturally-completing loop fibers. Deletes
    // the map entry only when it still references THIS fiber — a subsequent
    // idle event's registerFiber may have already interrupted the old fiber and
    // installed a new one, and deleting unconditionally would evict the new
    // fiber. Never interrupts: the calling fiber has already finished its work.
    const clearFiberIf = Effect.fnUntraced(function* (
      sessionID: SessionID,
      fiber: Fiber.Fiber<unknown, unknown>,
    ) {
      if (fibers.get(sessionID) === fiber) {
        fibers.delete(sessionID)
      }
    })

    function loadState(sessionID: SessionID) {
      return db
        .select()
        .from(GoalStateTable)
        .where(eq(GoalStateTable.session_id, sessionID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => {
            if (!row) return undefined
            return Schema.decodeUnknownSync(GoalState.Info)(JSON.parse(row.payload))
          }),
        )
    }

    type Transition<A> =
      | { readonly tag: "noop"; readonly value: A }
      | { readonly tag: "save"; readonly state: GoalState.Info; readonly value: A }
      | {
          readonly tag: "delete"
          readonly terminal?: GoalState.Info
          /** GOAL-FP-01-16: also delete every goal_outcome row for the session
           * in the same transaction (session deletion, not a plain clear). */
          readonly deleteOutcomes?: boolean
          readonly value: A
        }

    // The only durable Goal mutation seam. The immediate transaction makes the
    // read + decision + write/delete one serializable state transition, so a
    // stale loop result cannot overwrite a concurrent pause or resurrect a row
    // deleted by clear. Events are emitted after commit but inside the same
    // uninterruptible region; durable state always leads presentation state.
    const transition = <A>(
      sessionID: SessionID,
      decide: (state: GoalState.Info | undefined) => Transition<A>,
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const result = yield* db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const row = yield* tx
                    .select()
                    .from(GoalStateTable)
                    .where(eq(GoalStateTable.session_id, sessionID))
                    .get()
                  const current = row
                    ? Schema.decodeUnknownSync(GoalState.Info)(JSON.parse(row.payload))
                    : undefined
                  const next = decide(current)
                  if (next.tag === "save") {
                    const payload = JSON.stringify(Schema.encodeSync(GoalState.Info)(next.state))
                    if (row) {
                      yield* tx
                        .update(GoalStateTable)
                        .set({ payload, updated_at: Math.max(Date.now(), row.updated_at + 1) })
                        .where(eq(GoalStateTable.session_id, sessionID))
                        .run()
                    } else {
                      yield* tx
                        .insert(GoalStateTable)
                        .values({ session_id: sessionID, payload, updated_at: Date.now() })
                        .run()
                    }
                  }
                  if (next.tag === "delete" && row) {
                    if (next.terminal) {
                      const payload = JSON.stringify(Schema.encodeSync(GoalState.Info)(next.terminal))
                      const goalID =
                        next.terminal.goal_id && next.terminal.goal_id !== "legacy"
                          ? next.terminal.goal_id
                          : `${sessionID}:legacy:${next.terminal.created_at}`
                      yield* tx
                        .insert(GoalOutcomeTable)
                        .values({
                          goal_id: goalID,
                          session_id: sessionID,
                          payload,
                          completed_at: Date.now(),
                        })
                        .onConflictDoUpdate({
                          target: GoalOutcomeTable.goal_id,
                          set: { payload, completed_at: Date.now() },
                        })
                        .run()
                    }
                    yield* tx
                      .delete(GoalStateTable)
                      .where(eq(GoalStateTable.session_id, sessionID))
                      .run()
                  }
                  if (next.tag === "delete" && next.deleteOutcomes) {
                    yield* tx
                      .delete(GoalOutcomeTable)
                      .where(eq(GoalOutcomeTable.session_id, sessionID))
                      .run()
                  }
                  return next
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
          if (result.tag === "save") yield* publishGoal(sessionID, result.state)
          if (result.tag === "delete") {
            if (result.terminal) yield* publishGoal(sessionID, result.terminal)
            yield* events.publish(GoalEvent.Cleared, { sessionID })
          }
          return result.value
        }),
      )

    const matchesExpected = (
      state: GoalState.Info,
      expected?: { readonly goalID: string; readonly revision: number },
    ) =>
      !expected ||
      ((state.goal_id ?? "legacy") === expected.goalID && (state.revision ?? 0) === expected.revision)

    const deleteAndPublishDone = Effect.fnUntraced(function* (sessionID: SessionID, reason: string) {
      return yield* transition<GoalState.Info | undefined>(sessionID, (state) => {
        if (!state) return { tag: "noop", value: undefined }
        const doneState = GoalState.advance(state, {
          status: "done",
          last_verdict: "done",
          last_reason: reason,
        })
        return { tag: "delete", terminal: doneState, value: state }
      })
    })

    const load = Effect.fn("Goal.load")(function* (sessionID: SessionID) {
      return yield* loadState(sessionID)
    })

    // GOAL-FP-01-04: startup-resume scan accessor. GoalLoop is event-driven;
    // after a restart nothing emits idle for sessions whose goal was active
    // when the process died, so GoalLoop.init queries this durable set and
    // re-triggers its existing idle evaluation path. Only "active" rows are
    // returned — paused rows are user-visible and terminal rows are deleted
    // by transition.
    //
    // D-1: scoped to the instance's own directory. goal_state has no
    // directory column; the session table is the directory authority, so the
    // query joins goal_state.session_id → session.id and filters on
    // session.directory — the scan can never evaluate, commit, pause, or
    // drive another instance's sessions. Goal rows whose session row is
    // missing are dropped by the inner join (invisible to the scan, same as
    // other instances' rows).
    //
    // D-3: a row whose payload cannot be decoded is skipped defensively (the
    // scan is best-effort; the session's own idle event or /goal resume
    // remains available) but the skip is LOGGED with the session id and the
    // decode error — a silently-dormant goal is not diagnosable.
    const listActiveSessions = Effect.fn("Goal.listActiveSessions")(function* (directory: string) {
      const rows = yield* db
        .select({ session_id: GoalStateTable.session_id, payload: GoalStateTable.payload })
        .from(GoalStateTable)
        .innerJoin(SessionTable, sql`${GoalStateTable.session_id} = ${SessionTable.id}`)
        .where(eq(SessionTable.directory, directory))
        .all()
      const active: SessionID[] = []
      for (const row of rows) {
        let state: GoalState.Info
        try {
          state = Schema.decodeUnknownSync(GoalState.Info)(JSON.parse(row.payload))
        } catch (error) {
          yield* Effect.logWarning(
            `goal startup scan skipped undecodable goal_state row for ${row.session_id}`,
            { error: String(error) },
          )
          continue
        }
        if (state.status === "active") active.push(SessionID.make(row.session_id))
      }
      return active
    })

    const lastOutcome = Effect.fn("Goal.lastOutcome")(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(GoalOutcomeTable)
        .where(eq(GoalOutcomeTable.session_id, sessionID))
        .orderBy(desc(GoalOutcomeTable.completed_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return Schema.decodeUnknownSync(GoalState.Info)(JSON.parse(row.payload))
    })

    const set = Effect.fn("Goal.set")(function* (sessionID: SessionID, goal: string, maxTurns?: number) {
      const now = Date.now()
      const state = new GoalState.Info({
        goal_id: Bun.randomUUIDv7(),
        revision: GoalState.nni(0),
        goal,
        status: "active",
        turns_used: GoalState.nni(0),
        max_turns: GoalState.nni(maxTurns ?? GoalPrompts.DEFAULT_MAX_TURNS),
        created_at: now,
        last_turn_at: now,
        consecutive_parse_failures: GoalState.nni(0),
        subgoals: [],
      })
      const result = yield* transition(sessionID, () => ({ tag: "save", state, value: state }))
      yield* automation.register(sessionID, { kind: "goal", id: result.goal_id ?? "legacy" })
      return result
    })

    const pause = Effect.fn("Goal.pause")(function* (sessionID: SessionID, reason: string) {
      const updated = yield* transition(sessionID, (state) => {
        if (!state || state.status !== "active") return { tag: "noop", value: undefined }
        const next = GoalState.advance(state, {
          status: "paused",
          paused_reason: reason,
          last_turn_at: Date.now(),
        })
        return { tag: "save", state: next, value: next }
      })
      if (!updated) return undefined
      yield* automation.unregister(sessionID, { kind: "goal", id: updated.goal_id ?? "legacy" })
      yield* clearFiber(sessionID)
      return updated
    })

    // Loop-fiber-safe pause: same DB + event effects as pause(), but skips
    // clearFiber so it can be called from inside the loop fiber itself
    // (loop.ts shouldPreempt branch). The fiber naturally terminates when
    // afterIdle returns; no explicit interrupt needed.
    //
    // Wrapped in Effect.uninterruptible (F1): the save → publish sequence
    // is atomic, so an interrupt landing between persisting the paused row
    // and publishing goal.updated(paused) can never leave a paused DB row
    // with no corresponding event on the bus.
    const pauseAndPublish = Effect.fnUntraced(function* (sessionID: SessionID, reason: string) {
      return yield* transition(sessionID, (state) => {
        if (!state || state.status !== "active") return { tag: "noop", value: undefined }
        const updated = GoalState.advance(state, {
          status: "paused",
          paused_reason: reason,
          last_turn_at: Date.now(),
        })
        return { tag: "save", state: updated, value: updated }
      })
    })

    const resume = Effect.fn("Goal.resume")(function* (sessionID: SessionID) {
      const updated = yield* transition(sessionID, (state) => {
        if (!state || state.status !== "paused") return { tag: "noop", value: undefined }
        const updated = GoalState.advance(state, {
          status: "active",
          consecutive_parse_failures: GoalState.nni(0),
          paused_reason: undefined,
          last_turn_at: Date.now(),
        })
        return { tag: "save", state: updated, value: updated }
      })
      if (updated)
        yield* automation.register(sessionID, { kind: "goal", id: updated.goal_id ?? "legacy" })
      return updated
    })

    const clear = Effect.fn("Goal.clear")(function* (sessionID: SessionID) {
      const cleared = yield* transition(sessionID, (state) => ({ tag: "delete", value: state }))
      if (cleared)
        yield* automation.unregister(sessionID, { kind: "goal", id: cleared.goal_id ?? "legacy" })
      yield* clearFiber(sessionID)
    })

    // GOAL-FP-01-05/-16: session-deletion cleanup. `clear` keeps the
    // goal_outcome history (lastOutcome readers), but a deleted session has no
    // readers — its outcome rows are garbage and must go in the SAME durable
    // transition as the goal_state row so the pair cannot be split by a crash.
    const purgeSession = Effect.fn("Goal.purgeSession")(function* (sessionID: SessionID) {
      const cleared = yield* transition(sessionID, (state) => ({
        tag: "delete",
        deleteOutcomes: true,
        value: state,
      }))
      if (cleared)
        yield* automation.unregister(sessionID, { kind: "goal", id: cleared.goal_id ?? "legacy" })
      yield* clearFiber(sessionID)
    })

    const markDone = Effect.fn("Goal.markDone")(function* (sessionID: SessionID, reason: string) {
      // User/tool-initiated completion: stop the running loop fiber, then
      // perform terminal cleanup (publish done-updated → delete → publish cleared).
      // State transitions are budget-neutral — turns_used counts continuation
      // dispatches only (see spec: turn-budget-counts-continuation-dispatches-only),
      // so markDone does NOT increment. deleteAndPublishDone loads the current
      // row (preserving whatever turns_used a prior continue dispatch set) and
      // re-renders the done snapshot from it.
      yield* clearFiber(sessionID)
      const completed = yield* deleteAndPublishDone(sessionID, reason)
      if (completed)
        yield* automation.unregister(sessionID, { kind: "goal", id: completed.goal_id ?? "legacy" })
      return completed
    })

    const addSubgoal = Effect.fn("Goal.addSubgoal")(function* (sessionID: SessionID, subgoal: string) {
      return yield* transition(sessionID, (state) => {
        if (!state) return { tag: "noop", value: undefined }
        const updated = GoalState.advance(state, {
          subgoals: [...(state.subgoals ?? []), subgoal],
          last_turn_at: Date.now(),
        })
        return { tag: "save", state: updated, value: updated }
      })
    })

    const removeSubgoal = Effect.fn("Goal.removeSubgoal")(function* (sessionID: SessionID, index: number) {
      return yield* transition<RemoveSubgoalResult>(sessionID, (state) => {
        if (!state) return { tag: "noop", value: { tag: "noState" as const } }
        const subgoals = state.subgoals ?? []
        const idx = index - 1
        if (idx < 0 || idx >= subgoals.length)
          return { tag: "noop", value: { tag: "outOfBounds" as const, size: subgoals.length } }
        const removed = subgoals[idx]
        const updated = GoalState.advance(state, {
          subgoals: subgoals.filter((_, i) => i !== idx),
          last_turn_at: Date.now(),
        })
        return { tag: "save", state: updated, value: { tag: "ok" as const, removed, state: updated } }
      })
    })

    const clearSubgoals = Effect.fn("Goal.clearSubgoals")(function* (sessionID: SessionID) {
      return yield* transition(sessionID, (state) => {
        if (!state) return { tag: "noop", value: undefined }
        const updated = GoalState.advance(state, {
          subgoals: [],
          last_turn_at: Date.now(),
        })
        return { tag: "save", state: updated, value: updated }
      })
    })

    const statusLine = Effect.fn("Goal.statusLine")(function* (sessionID: SessionID) {
      const state = yield* loadState(sessionID)
      if (!state) return undefined
      const subgoals = state.subgoals ?? []
      const sub = subgoals.length > 0 ? `，${subgoals.length} 个子目标` : ""
      if (state.status === "active")
        return `⊙ 目标（进行中，${state.turns_used}/${state.max_turns} 轮${sub}）：${state.goal}`
      if (state.status === "paused") {
        const reason = state.paused_reason ? ` — ${state.paused_reason}` : ""
        return `⏸ 目标（已暂停，${state.turns_used}/${state.max_turns} 轮${reason}）：${state.goal}`
      }
      if (state.status === "done")
        return `✓ 目标已完成（${state.turns_used}/${state.max_turns} 轮）：${state.goal}`
      return undefined
    })

    const updateAfterJudge = Effect.fn("Goal.updateAfterJudge")(function* (
      sessionID: SessionID,
      verdict: GoalState.Verdict,
      reason: string,
      parseFailed: boolean,
      expected?: { readonly goalID: string; readonly revision: number },
    ) {
      return yield* transition(sessionID, (state) => {
        if (!state || state.status !== "active" || !matchesExpected(state, expected))
          return { tag: "noop", value: undefined }

        const now = Date.now()
        const newParseFailures = parseFailed ? state.consecutive_parse_failures + 1 : 0
        if (verdict === "done") {
          const updated = GoalState.advance(state, {
            status: "done",
            last_turn_at: now,
            last_verdict: "done",
            last_reason: reason,
            consecutive_parse_failures: GoalState.nni(newParseFailures),
          })
          return {
            tag: "delete",
            terminal: updated,
            value: {
              state: updated,
              shouldContinue: false,
              message: `✓ 目标已达成：${reason}`,
            },
          }
        }

        if (verdict === "blocked") {
          const updated = GoalState.advance(state, {
            status: "paused",
            last_turn_at: now,
            last_verdict: "blocked",
            last_reason: reason,
            paused_reason: reason,
            consecutive_parse_failures: GoalState.nni(newParseFailures),
          })
          return {
            tag: "save",
            state: updated,
            value: {
              state: updated,
              shouldContinue: false,
              message: `⏸ 目标已阻塞 — ${reason}`,
            },
          }
        }

        const turnsUsed = GoalState.nni(state.turns_used + 1)
        const pauseReason =
          newParseFailures >= GoalPrompts.MAX_CONSECUTIVE_PARSE_FAILURES
            ? "judge 模型未返回有效 JSON 判定。请检查模型配置或换用更可靠的模型，然后 /goal resume。"
            : turnsUsed >= state.max_turns
              ? `已用 ${turnsUsed}/${state.max_turns} 轮。使用 /goal resume 继续，或 /goal clear 停止。`
              : undefined
        const updated = GoalState.advance(state, {
          status: pauseReason ? "paused" : "active",
          turns_used: turnsUsed,
          last_turn_at: now,
          last_verdict: "continue",
          last_reason: reason,
          paused_reason: pauseReason,
          consecutive_parse_failures: GoalState.nni(newParseFailures),
        })
        return {
          tag: "save",
          state: updated,
          value: {
            state: updated,
            shouldContinue: !pauseReason,
            message: pauseReason
              ? `⏸ 目标已暂停 — ${pauseReason}`
              : `↻ 继续推进目标（${updated.turns_used}/${updated.max_turns}）：${reason}`,
          },
        }
      })
    })

    const dispatch = Effect.fn("Goal.dispatch")(function* (sessionID: SessionID, args: string) {
      const trimmed = args.trim()
      const lower = trimmed.toLowerCase()

      const isControlCommand =
        lower === "" ||
        lower === "status" ||
        lower === "pause" ||
        lower === "resume" ||
        lower === "clear" ||
        lower === "stop" ||
        lower === "done"
      if (!isControlCommand) {
        const status = yield* sessionStatus.get(sessionID)
        if (status.type === "busy") {
          return {
            type: "message" as const,
            text: "Session 正在执行中。请先 /stop 中断后再设定新目标。",
          }
        }
        // Known TOCTOU: `get` above then goal.set + continuation dispatch below
        // is not atomic — the session could flip to busy in between. Accepted:
        // the loop's idle gating and judge-preempt guard handle that case
        // gracefully; an atomic check-and-set would need a session-level lock
        // outside this module's scope.
      }

      if (lower === "" || lower === "status") {
        const line = yield* statusLine(sessionID)
        return { type: "message" as const, text: line ?? "没有活跃的目标。使用 /goal <text> 设定一个目标。" }
      }

      if (lower === "pause") {
        const result = yield* pause(sessionID, "user-paused")
        return {
          type: "message" as const,
          text: result
            ? `⏸ 目标已暂停。/goal resume 继续。`
            : "没有活跃的目标可以暂停。",
        }
      }

      if (lower === "resume") {
        // Busy guard, symmetric with the set-new-goal guard above. `resume` is a
        // control command so it bypasses the generic busy check; without this,
        // resuming a goal on a busy session would return `kick`, prompting
        // prompt.ts to start a second agent loop concurrently with the running
        // one. Keep the goal paused and ask the user to /stop first instead.
        const resumeStatus = yield* sessionStatus.get(sessionID)
        if (resumeStatus.type === "busy") {
          return {
            type: "message" as const,
            text: "Session 正在执行中。请先 /stop 中断后再 /goal resume。",
          }
        }
        const result = yield* resume(sessionID)
        if (!result) return { type: "message" as const, text: "没有已暂停的目标可以恢复。" }
        // Warning UX for budget-exhaustion pauses: we kept turns_used intact
        // (see resume()), so a goal paused because turns >= max will resume
        // only to get immediately re-paused by the next judge iteration.
        // Without a warning the user sees "已恢复" then the same pause
        // text a second later, which looks like resume didn't work.
        const announceMsg =
          result.turns_used >= result.max_turns
            ? `⚠ 目标已恢复，但预算已耗尽（${result.turns_used}/${result.max_turns} 轮）。下一轮 judge 会立刻再次判定超预算暂停。建议 /goal clear 后重新 /goal <text>，或在 /goal set 时传更大的 maxTurns。`
            : undefined
        return {
          type: "kick" as const,
          text: result.goal,
          announce: announceMsg,
        }
      }

      if (lower === "done") {
        // /goal done is explicit "I finished this" — distinct from
        // /goal clear (/stop), which just tears it down without marking
        // completion. Both remove the row because done is transient.
        yield* markDone(sessionID, "/goal done")
        return { type: "message" as const, text: "✓ 目标已标记为完成并清除。" }
      }

      if (lower === "clear" || lower === "stop") {
        yield* clear(sessionID)
        return { type: "message" as const, text: "目标已清除。" }
      }

      const existing = yield* loadState(sessionID)
      if (existing) {
        if (existing.status === "active") {
          return {
            type: "message" as const,
            text: "已有活跃目标。请先 /goal clear 再设定新目标。",
          }
        }
        if (existing.status === "paused") {
          return {
            type: "message" as const,
            text: `有暂停的目标（${existing.turns_used}/${existing.max_turns} 轮）。使用 /goal resume 继续，/goal clear 后再设定新目标。`,
          }
        }
        // done row leftover (loop.ts usually auto-clears; defensive guard)
        yield* clear(sessionID)
      }
      const maxTurns = GoalPrompts.DEFAULT_MAX_TURNS
      const state = yield* set(sessionID, trimmed, maxTurns)
      return {
        type: "kick" as const,
        text: state.goal,
        announce: `⊙ 目标已设定（${state.max_turns} 轮预算）：${state.goal}`,
      }
    })

    const dispatchSubgoal = Effect.fn("Goal.dispatchSubgoal")(function* (sessionID: SessionID, args: string) {
      const trimmed = args.trim()
      const lower = trimmed.toLowerCase()

      if (lower === "" || lower === "list") {
        const state = yield* loadState(sessionID)
        const subgoals = state?.subgoals ?? []
        if (!state || subgoals.length === 0)
          return { type: "message" as const, text: "没有子目标。使用 /subgoal add <text> 添加。" }
        const lines = subgoals.map((s, i) => `${i + 1}. ${s}`)
        return { type: "message" as const, text: `子目标：\n${lines.join("\n")}` }
      }

      if (lower === "clear") {
        const result = yield* clearSubgoals(sessionID)
        return {
          type: "message" as const,
          text: result ? "子目标已清除。" : "没有活跃的目标。",
        }
      }

      if (lower.startsWith("remove ") || lower.startsWith("rm ")) {
        const indexStr = trimmed.replace(/^(?:remove|rm)\s+/i, "")
        const index = parseInt(indexStr, 10)
        if (isNaN(index) || index < 1) return { type: "message" as const, text: "用法：/subgoal remove <编号>" }
        const result = yield* removeSubgoal(sessionID, index)
        if (result.tag === "noState") return { type: "message" as const, text: "没有活跃的目标。" }
        if (result.tag === "outOfBounds") {
          return {
            type: "message" as const,
            text:
              result.size === 0
                ? "当前没有子目标。"
                : `索引越界：当前只有 ${result.size} 个子目标，#1 至 #${result.size}。`,
          }
        }
        return { type: "message" as const, text: `子目标 #${index} 已移除：${result.removed}` }
      }

      if (lower.startsWith("add ")) {
        const subgoal = trimmed.slice(4).trim()
        if (!subgoal) return { type: "message" as const, text: "用法：/subgoal add <text>" }
        const result = yield* addSubgoal(sessionID, subgoal)
        return {
          type: "message" as const,
          text: result ? `子目标已添加：${subgoal}` : "没有活跃的目标。先使用 /goal <text> 设定一个目标。",
        }
      }

      const result = yield* addSubgoal(sessionID, trimmed)
      return {
        type: "message" as const,
        text: result ? `子目标已添加：${trimmed}` : "没有活跃的目标。先使用 /goal <text> 设定一个目标。",
      }
    })

    return Service.of({
      load,
      listActiveSessions,
      lastOutcome,
      set,
      pause,
      resume,
      clear,
      purgeSession,
      markDone,
      addSubgoal,
      removeSubgoal,
      clearSubgoals,
      statusLine,
      dispatch,
      dispatchSubgoal,
      updateAfterJudge,
      registerLoopFiber: registerFiber,
      clearLoopFiber: clearFiber,
      clearLoopFiberIf: clearFiberIf,
      deleteAndPublishDone,
      pauseAndPublish,
    })
  }),
)

export const layer = serviceLayer.pipe(Layer.provide(SessionAutomationLease.defaultLayer))

export const defaultLayer = layer.pipe(
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export const node = LayerNode.make(layer, [
  EventV2Bridge.node,
  Database.node,
  SessionStatus.node,
])
