export * as Goal from "./goal"

import { Effect, Layer, Context, Schema, Fiber } from "effect"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GoalState } from "./state"
import { GoalStateTable } from "@opencode-ai/core/goal/sql"
import { GoalEvent } from "./events"
import { GoalPrompts } from "./prompts"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"

export interface Interface {
  readonly load: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  readonly set: (sessionID: SessionID, goal: string, maxTurns?: number) => Effect.Effect<GoalState.Info>
  readonly pause: (sessionID: SessionID, reason: string) => Effect.Effect<GoalState.Info | undefined>
  readonly resume: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly markDone: (sessionID: SessionID, reason: string) => Effect.Effect<GoalState.Info | undefined>
  readonly addSubgoal: (sessionID: SessionID, subgoal: string) => Effect.Effect<GoalState.Info | undefined>
  readonly removeSubgoal: (
    sessionID: SessionID,
    /** 1-based index of the subgoal to remove (1 = first subgoal). */
    index: number,
  ) => Effect.Effect<
    | { tag: "ok"; removed: string; state: GoalState.Info }
    | { tag: "noState" }
    | { tag: "outOfBounds"; size: number }
  >
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
    verdict: "done" | "continue",
    reason: string,
    parseFailed: boolean,
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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    const sessionStatus = yield* SessionStatus.Service

    // Unified event publisher — every state change publishes goal.updated
    // with the full snapshot, identical to Todo's todo.updated pattern.
    const publishGoal = (sessionID: SessionID, state: GoalState.Info) =>
      events.publish(GoalEvent.Updated, {
        sessionID,
        goal: {
          goal: state.goal,
          status: state.status as "active" | "paused" | "done",
          turnsUsed: Number(state.turns_used),
          maxTurns: Number(state.max_turns),
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

    // Terminal cleanup for "done" transitions. Loads current state (if any),
    // constructs a transient snapshot with status="done" + the given reason,
    // emits goal.updated(done), deletes the row, then emits goal.cleared.
    //
    // Does NOT touch the fiber map. This is the key safety property:
    //   - markDone (user-initiated from slash command or goal.complete
    //     tool) calls clearFiber FIRST, then deleteAndPublishDone — the
    //     loop fiber is already stopped when this runs.
    //   - loop.ts done branch calls deleteAndPublishDone DIRECTLY from
    //     inside the loop fiber — so it must not self-interrupt.
    //
    // Without this separation, calling goal.clear() from within afterIdle
    // would interrupt ourselves before goal.cleared was published (the
    // event bus would miss the terminal event, and TUI/SSE consumers
    // polling state would never see the transition).
    //
    // The whole terminal sequence (load → publish(done) → delete →
    // publish(cleared)) runs inside Effect.uninterruptible. This is
    // defense-in-depth (F1): even if a future caller arranges for the loop
    // fiber to be interrupted mid-call, the terminal event contract still
    // completes atomically — goal.cleared cannot be skipped by an interrupt
    // landing between publish(done) and publish(cleared). The operations are
    // short synchronous DB + event publishes, so there is no deadlock risk.
    const deleteAndPublishDone = Effect.fnUntraced(function* (sessionID: SessionID, reason: string) {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const state = yield* loadState(sessionID)
          if (state) {
            const doneState = new GoalState.Info({
              ...state,
              status: "done",
              last_verdict: "done",
              last_reason: reason,
            })
            yield* publishGoal(sessionID, doneState)
          }
          yield* deleteState(sessionID)
          yield* events.publish(GoalEvent.Cleared, { sessionID })
          return state
        }),
      )
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

    function saveState(sessionID: SessionID, state: GoalState.Info) {
      const payload = JSON.stringify(Schema.encodeSync(GoalState.Info)(state))
      return db
        .insert(GoalStateTable)
        .values({ session_id: sessionID, payload, updated_at: Date.now() })
        .onConflictDoUpdate({
          target: GoalStateTable.session_id,
          set: { payload, updated_at: Date.now() },
        })
        .run()
        .pipe(Effect.orDie)
    }

    function deleteState(sessionID: SessionID) {
      return db
        .delete(GoalStateTable)
        .where(eq(GoalStateTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
    }

    const load = Effect.fn("Goal.load")(function* (sessionID: SessionID) {
      return yield* loadState(sessionID)
    })

    const set = Effect.fn("Goal.set")(function* (sessionID: SessionID, goal: string, maxTurns?: number) {
      const now = Date.now()
      const state = new GoalState.Info({
        goal,
        status: "active",
        turns_used: GoalState.nni(0),
        max_turns: GoalState.nni(maxTurns ?? GoalPrompts.DEFAULT_MAX_TURNS),
        created_at: now,
        last_turn_at: now,
        consecutive_parse_failures: GoalState.nni(0),
        subgoals: [],
      })
      yield* saveState(sessionID, state)
      yield* publishGoal(sessionID, state)
      return state
    })

    const pause = Effect.fn("Goal.pause")(function* (sessionID: SessionID, reason: string) {
      const state = yield* loadState(sessionID)
      if (!state || state.status !== "active") return undefined
      const updated = new GoalState.Info({
        ...state,
        status: "paused",
        paused_reason: reason,
        last_turn_at: Date.now(),
      })
      yield* saveState(sessionID, updated)
      yield* clearFiber(sessionID)
      yield* publishGoal(sessionID, updated)
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
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const state = yield* loadState(sessionID)
          if (!state || state.status !== "active") return undefined
          const updated = new GoalState.Info({
            ...state,
            status: "paused",
            paused_reason: reason,
            last_turn_at: Date.now(),
          })
          yield* saveState(sessionID, updated)
          yield* publishGoal(sessionID, updated)
          return updated
        }),
      )
    })

    const resume = Effect.fn("Goal.resume")(function* (sessionID: SessionID) {
      const state = yield* loadState(sessionID)
      if (!state || state.status !== "paused") return undefined
      // Preserve turns_used so the original max_turns budget is respected.
      // Resetting to 0 would silently grant another full budget, defeating
      // `max_turns` as a runaway guard — a paused goal that exhausted its
      // budget would immediately re-exhaust the new budget on resume.
      // Users wanting a fresh budget should /goal clear and /goal <text>.
      const updated = new GoalState.Info({
        ...state,
        status: "active",
        consecutive_parse_failures: GoalState.nni(0),
        paused_reason: undefined,
        last_turn_at: Date.now(),
      })
      yield* saveState(sessionID, updated)
      yield* publishGoal(sessionID, updated)
      return updated
    })

    const clear = Effect.fn("Goal.clear")(function* (sessionID: SessionID) {
      yield* deleteState(sessionID)
      yield* clearFiber(sessionID)
      yield* events.publish(GoalEvent.Cleared, { sessionID })
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
      return yield* deleteAndPublishDone(sessionID, reason)
    })

    const addSubgoal = Effect.fn("Goal.addSubgoal")(function* (sessionID: SessionID, subgoal: string) {
      const state = yield* loadState(sessionID)
      if (!state) return undefined
      const updated = new GoalState.Info({
        ...state,
        subgoals: [...(state.subgoals ?? []), subgoal],
        last_turn_at: Date.now(),
      })
      yield* saveState(sessionID, updated)
      yield* publishGoal(sessionID, updated)
      return updated
    })

    const removeSubgoal = Effect.fn("Goal.removeSubgoal")(function* (sessionID: SessionID, index: number) {
      const state = yield* loadState(sessionID)
      if (!state) return { tag: "noState" as const }
      const subgoals = state.subgoals ?? []
      const idx = index - 1
      if (idx < 0 || idx >= subgoals.length) return { tag: "outOfBounds" as const, size: subgoals.length }
      const removed = subgoals[idx]
      const updated = new GoalState.Info({
        ...state,
        subgoals: subgoals.filter((_, i) => i !== idx),
        last_turn_at: Date.now(),
      })
      yield* saveState(sessionID, updated)
      yield* publishGoal(sessionID, updated)
      return { tag: "ok" as const, removed, state: updated }
    })

    const clearSubgoals = Effect.fn("Goal.clearSubgoals")(function* (sessionID: SessionID) {
      const state = yield* loadState(sessionID)
      if (!state) return undefined
      const updated = new GoalState.Info({
        ...state,
        subgoals: [],
        last_turn_at: Date.now(),
      })
      yield* saveState(sessionID, updated)
      yield* publishGoal(sessionID, updated)
      return updated
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
      verdict: "done" | "continue",
      reason: string,
      parseFailed: boolean,
    ) {
      const state = yield* loadState(sessionID)
      if (!state || state.status !== "active") return undefined

      const now = Date.now()
      const newParseFailures = parseFailed ? state.consecutive_parse_failures + 1 : 0

      if (verdict === "done") {
        const updated = new GoalState.Info({
          ...state,
          status: "done",
          // State transitions are budget-neutral — a `done` verdict drives no
          // continuation dispatch, so it must NOT consume budget. turns_used
          // reflects only continuation dispatches (see spec:
          // turn-budget-counts-continuation-dispatches-only).
          turns_used: state.turns_used,
          last_turn_at: now,
          last_verdict: "done",
          last_reason: reason,
          consecutive_parse_failures: GoalState.nni(newParseFailures),
        })
        yield* saveState(sessionID, updated)
        // Do NOT publish goal.updated here. deleteAndPublishDone is the SOLE
        // owner of the terminal event sequence (goal.updated(done) → delete →
        // goal.cleared); publishing here would double-fire goal.updated(done)
        // on every judge-declared completion (see spec:
        // terminal-event-contract-publishes-exactly-once). We still saveState
        // so deleteAndPublishDone can load the done row and re-render the
        // snapshot. loop.ts invokes deleteAndPublishDone after this returns.
        return {
          state: updated,
          shouldContinue: false,
          message: `✓ 目标已达成：${reason}`,
        }
      }

      const turnsUsed = GoalState.nni(Number(state.turns_used) + 1)

      if (newParseFailures >= GoalPrompts.MAX_CONSECUTIVE_PARSE_FAILURES) {
        const pauseReason =
          "judge 模型未返回有效 JSON 判定。请检查模型配置或换用更可靠的模型，然后 /goal resume。"
        const updated = new GoalState.Info({
          ...state,
          status: "paused",
          turns_used: turnsUsed,
          last_turn_at: now,
          last_verdict: "continue",
          last_reason: reason,
          paused_reason: pauseReason,
          consecutive_parse_failures: GoalState.nni(newParseFailures),
        })
        // Do NOT call clearFiber here. updateAfterJudge is inlined into
        // GoalLoop.afterIdle (loop.ts:122), so the fiber running this code
        // IS the one registered in the fibers map — clearFiber would
        // self-interrupt before publishGoal reaches the event bus, leaving
        // the pause invisible to SSE/TUI and aborting the rest of afterIdle.
        // The fiber naturally terminates when afterIdle returns; no explicit
        // interrupt is needed (same rationale as pauseAndPublish /
        // deleteAndPublishDone).
        yield* saveState(sessionID, updated)
        yield* publishGoal(sessionID, updated)
        return {
          state: updated,
          shouldContinue: false,
          message: `⏸ 目标已暂停 — ${pauseReason}`,
        }
      }

      if (turnsUsed >= state.max_turns) {
        const pauseReason = `已用 ${turnsUsed}/${state.max_turns} 轮。使用 /goal resume 继续，或 /goal clear 停止。`
        const updated = new GoalState.Info({
          ...state,
          status: "paused",
          turns_used: turnsUsed,
          last_turn_at: now,
          last_verdict: "continue",
          last_reason: reason,
          paused_reason: pauseReason,
          consecutive_parse_failures: GoalState.nni(newParseFailures),
        })
        // Same self-interrupt hazard as the parse-failure branch above: we
        // are running inside the afterIdle loop fiber, so clearFiber would
        // interrupt ourselves before publishGoal(paused) fires.
        yield* saveState(sessionID, updated)
        yield* publishGoal(sessionID, updated)
        return {
          state: updated,
          shouldContinue: false,
          message: `⏸ 目标已暂停 — ${pauseReason}`,
        }
      }

      const updated = new GoalState.Info({
        ...state,
        status: "active",
        turns_used: turnsUsed,
        last_turn_at: now,
        last_verdict: "continue",
        last_reason: reason,
        consecutive_parse_failures: GoalState.nni(newParseFailures),
      })
      yield* saveState(sessionID, updated)
      yield* publishGoal(sessionID, updated)
      return {
        state: updated,
        shouldContinue: true,
        message: `↻ 继续推进目标（${updated.turns_used}/${updated.max_turns}）：${reason}`,
      }
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
          Number(result.turns_used) >= Number(result.max_turns)
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
      set,
      pause,
      resume,
      clear,
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

export const defaultLayer = layer.pipe(
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, Database.node, SessionStatus.node])
