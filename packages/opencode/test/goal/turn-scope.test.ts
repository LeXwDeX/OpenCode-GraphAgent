import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Goal } from "@/goal/goal"
import { GoalState } from "@/goal/state"
import { GoalPrompts } from "@/goal/prompts"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Database } from "@opencode-ai/core/database/database"
import { GoalStateTable } from "@opencode-ai/core/goal/sql"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// GOAL-TURN-SCOPE regression tests: the turn-provenance mark (kick /
// continuation / resume-kick) drives (a) the goal-turn step ceiling surfaced by
// goalTurnMaxSteps, (b) ESC-on-goal-turn mapping to a durable pause, and (c)
// mark lifecycle across terminal transitions. Uses the real Goal layer (same
// shape as goal.test.ts) so the durable row, the event bus, and the
// process-local mark are all exercised.

const testLayer = Goal.layer.pipe(
  // provideMerge (not provide): the statusLine test body yields
  // SessionStatus.Service to set busy/idle — it must see the SAME instance the
  // Goal service reads. Database is merged for the GOAL-02 fault injection
  // (the test body corrupts/restores the goal_state payload directly).
  Layer.provideMerge(EventV2Bridge.defaultLayer),
  Layer.provideMerge(SessionStatus.defaultLayer),
  Layer.provideMerge(Database.defaultLayer),
)

const it = testEffect(testLayer)

describe("Goal turn-scope — markTurnDriven / goalTurnMaxSteps", () => {
  it.live("unmarked session reports no ceiling", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      yield* goal.set(sid, "test goal", 5)
      expect(yield* goal.goalTurnMaxSteps(sid)).toBeUndefined()
    }),
  )

  it.live("marked + active goal reports GOAL_TURN_MAX_STEPS", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      yield* goal.set(sid, "test goal", 5)
      yield* goal.markTurnDriven(sid)
      expect(yield* goal.isTurnDriven(sid)).toBe(true)
      expect(yield* goal.goalTurnMaxSteps(sid)).toBe(GoalPrompts.GOAL_TURN_MAX_STEPS)
    }),
  )

  it.live("stale mark (goal cleared) self-retires and reports no ceiling", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      yield* goal.set(sid, "test goal", 5)
      yield* goal.markTurnDriven(sid)
      yield* goal.clear(sid)
      // The durable row is gone: the next goalTurnMaxSteps probe must drop the
      // mark instead of capping an unrelated turn.
      expect(yield* goal.goalTurnMaxSteps(sid)).toBeUndefined()
      expect(yield* goal.isTurnDriven(sid)).toBe(false)
    }),
  )

  it.live("stale mark (goal paused) self-retires and reports no ceiling", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      yield* goal.set(sid, "test goal", 5)
      yield* goal.markTurnDriven(sid)
      yield* goal.pause(sid, "user-paused")
      expect(yield* goal.goalTurnMaxSteps(sid)).toBeUndefined()
    }),
  )
})

describe("Goal turn-scope — pauseForUserCancel (ESC semantics)", () => {
  it.live("ESC on a marked turn pauses the goal durably and clears the mark", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      yield* goal.set(sid, "test goal", 5)
      yield* goal.markTurnDriven(sid)

      const paused = yield* goal.pauseForUserCancel(sid, "用户中断（ESC）— /goal resume 继续")
      expect(paused?.status).toBe("paused")

      const state = yield* goal.load(sid)
      expect(state?.status).toBe("paused")
      expect(state?.paused_reason).toBe("用户中断（ESC）— /goal resume 继续")
      expect(yield* goal.isTurnDriven(sid)).toBe(false)
      // A paused goal reports no step ceiling even if the mark somehow leaked.
      expect(yield* goal.goalTurnMaxSteps(sid)).toBeUndefined()
    }),
  )

  it.live("ESC-like cancel without an active goal is a no-op", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      const paused = yield* goal.pauseForUserCancel(sid, "ESC")
      expect(paused).toBeUndefined()
    }),
  )

  // GOAL-02: when the pause cannot be persisted after all retries, the durable
  // row is still "active" and the lease registration is still in place — the
  // process-local turnDriven mark must AGREE with both (kept, not deleted).
  // Pre-fix the mark was deleted unconditionally, which lost the ESC
  // provenance: the resurrected turn's second ESC no longer routed through the
  // goal pause fast path.
  it.live("pause failure after retries keeps the turn mark (durable row, lease, mark agree on active)", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const { db } = yield* Database.Service
      const sid = SessionID.descending()
      const seeded = yield* goal.set(sid, "test goal", 5)
      yield* goal.markTurnDriven(sid)

      // Deterministic pause failure: corrupt the durable row's payload so the
      // transition's decode defects on every one of the three retry attempts.
      yield* db
        .update(GoalStateTable)
        .set({ payload: "{corrupt" })
        .where(eq(GoalStateTable.session_id, sid))
        .run()

      const paused = yield* goal.pauseForUserCancel(sid, "用户中断（ESC）")
      expect(paused).toBeUndefined()
      expect(yield* goal.isTurnDriven(sid)).toBe(true)

      // Restore a valid active row: the pause seam works again, and the
      // successful pause clears the mark exactly like the healthy path.
      yield* db
        .update(GoalStateTable)
        .set({ payload: JSON.stringify(Schema.encodeSync(GoalState.Info)(seeded)) })
        .where(eq(GoalStateTable.session_id, sid))
        .run()

      const retried = yield* goal.pauseForUserCancel(sid, "用户中断（ESC）重试")
      expect(retried?.status).toBe("paused")
      expect(yield* goal.isTurnDriven(sid)).toBe(false)
    }),
  )

  it.live("terminal transitions clear the mark (markDone)", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      yield* goal.set(sid, "test goal", 5)
      yield* goal.markTurnDriven(sid)
      yield* goal.markDone(sid, "/goal done")
      expect(yield* goal.isTurnDriven(sid)).toBe(false)
      expect(yield* goal.load(sid)).toBeUndefined()
    }),
  )

  it.live("terminal transitions clear the mark (purgeSession)", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      yield* goal.set(sid, "test goal", 5)
      yield* goal.markTurnDriven(sid)
      yield* goal.purgeSession(sid)
      expect(yield* goal.isTurnDriven(sid)).toBe(false)
    }),
  )
})

describe("Goal turn-scope — statusLine executing indicator", () => {
  // status.set needs an instance context (InstanceRef) — use it.instance so the
  // test runs with a scoped temp instance.
  it.instance("marked + busy session shows 执行中; idle shows 进行中", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const status = yield* SessionStatus.Service
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship it", 5)

      const idleLine = yield* goal.statusLine(sid)
      expect(idleLine).toContain("进行中")
      expect(idleLine).not.toContain("执行中")

      yield* goal.markTurnDriven(sid)
      yield* status.set(sid, { type: "busy" })
      const busyLine = yield* goal.statusLine(sid)
      expect(busyLine).toContain("执行中")
      expect(busyLine).toContain("0/5")

      // Marked but idle (turn ended, mark not yet retired) falls back to 进行中.
      yield* status.set(sid, { type: "idle" })
      const backIdle = yield* goal.statusLine(sid)
      expect(backIdle).toContain("进行中")
    }),
  )
})
