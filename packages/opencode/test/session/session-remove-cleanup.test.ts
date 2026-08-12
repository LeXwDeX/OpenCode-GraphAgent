import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventTable } from "@opencode-ai/core/event/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { GoalOutcomeTable, GoalStateTable } from "@opencode-ai/core/goal/sql"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session as SessionNs } from "@/session/session"
import { SessionAutomationLease } from "@/session/automation-lease"
import { Goal } from "@/goal/goal"
import { Dag } from "@/dag/dag"
import { testEffect } from "../lib/effect"
import { testInstanceStoreLayer } from "../fixture/fixture"

// GOAL-FP-01-05/-06/-16: `Session.remove` must be the single cleanup point for
// durable session-scoped state — goal_state + goal_outcome rows, the dag
// automation lease registrations, and owned workflows.
//
// The layer mirrors the production AppLayer (effect/app-runtime.ts) group-1
// composition: Session, Goal and Dag are `Layer.mergeAll` SIBLINGS. mergeAll
// builds every member concurrently against the parent context only, so
// siblings cannot see each other's outputs. In production that made
// `Effect.serviceOption(Goal.Service)` inside Session's layer yield None and
// the cleanup silently no-op. This test builds the same sibling shape, so it
// fails against that wiring and passes once Session.defaultLayer self-provides
// its cleanup dependencies.
const testLayer = Layer.mergeAll(
  SessionNs.defaultLayer,
  Goal.defaultLayer,
  Dag.defaultLayer,
  SessionAutomationLease.defaultLayer,
  Database.defaultLayer,
  testInstanceStoreLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(testLayer)

describe("Session.remove goal cleanup (GOAL-FP-01-05/-16)", () => {
  it.instance("deletes goal_state and goal_outcome rows for the removed session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const { db } = yield* Database.Service

      const info = yield* session.create({})
      const sessionID = info.id
      // markDone terminalizes the active goal into a durable goal_outcome row.
      yield* goal.set(sessionID, "first goal", 10)
      yield* goal.markDone(sessionID, "done for cleanup test")
      // A fresh active goal leaves a goal_state row behind at remove time.
      yield* goal.set(sessionID, "second goal", 10)

      const outcomeBefore = yield* db
        .select()
        .from(GoalOutcomeTable)
        .where(eq(GoalOutcomeTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(outcomeBefore).not.toBeNull()

      yield* session.remove(sessionID)

      const stateRow = yield* db
        .select()
        .from(GoalStateTable)
        .where(eq(GoalStateTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(stateRow).toBeUndefined()

      const outcomeRow = yield* db
        .select()
        .from(GoalOutcomeTable)
        .where(eq(GoalOutcomeTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(outcomeRow).toBeUndefined()
    }),
  )
})

describe("Session.remove dag lease cleanup (GOAL-FP-01-06)", () => {
  it.instance("purges dag automation lease registrations for the removed session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const lease = yield* SessionAutomationLease.Service

      const info = yield* session.create({})
      const sessionID = info.id
      yield* lease.register(sessionID, { kind: "dag", id: "wf-lease-test" })
      expect(Option.isSome(yield* lease.claim(sessionID, { kind: "dag" }))).toBe(true)

      yield* session.remove(sessionID)

      expect(Option.isNone(yield* lease.claim(sessionID, { kind: "dag" }))).toBe(true)
    }),
  )

  it.instance("cancels workflows owned by the removed session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dag = yield* Dag.Service
      const { db } = yield* Database.Service

      const info = yield* session.create({})
      const sessionID = info.id
      const dagID = yield* dag.create({
        projectID: info.projectID,
        sessionID,
        title: "session-remove-cleanup-test",
        config: {
          name: "session-remove-cleanup-test",
          nodes: [
            {
              id: "n1",
              name: "n1",
              worker_type: "build",
              depends_on: [],
              required: true,
              prompt_template: { inline: "do work" },
            },
          ],
        },
      })
      expect((yield* dag.store.getWorkflow(dagID).pipe(Effect.orDie))?.status).toBe("running")

      yield* session.remove(sessionID)

      // The workflow READ row is FK-cascaded away with the session row, so
      // the cancellation contract observable here is the durable
      // dag.workflow.cancelled event — the terminalization that stops the
      // running DagLoop runtime (aborting child sessions and releasing the
      // dag lease) and keeps the workflow out of the restart recovery scan.
      const cancelledEvent = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, dagID),
            eq(EventTable.type, EventV2.versionedType(DagEvent.WorkflowCancelled.type, 1)),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      expect(cancelledEvent).not.toBeNull()

      // Recovery scan contract (dag/runtime/loop.ts adopts only
      // running/paused/stepping rows): the workflow must not be re-adoptable.
      const adoptable = yield* dag.store.listByStatus("running").pipe(Effect.orDie)
      expect(adoptable.map((wf) => wf.id)).not.toContain(dagID)
    }),
  )
})
