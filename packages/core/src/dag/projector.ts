export * as DagProjector from "./projector"

import { and, eq, inArray, sql } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { LayerNode } from "../effect/layer-node"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { WorkflowNodeTable, WorkflowTable } from "./sql"

type DatabaseService = Database.Interface["db"]
type WorkflowStatus = DagEvent.WorkflowStatus
const toMillis = (dt: DateTime.Utc) => DateTime.toEpochMillis(dt)

/** Cast a status string to the WorkflowStatus literal type for Drizzle. */
const ws = (s: WorkflowStatus) => s as DagEvent.WorkflowStatus

/**
 * DAG projector: EventV2 → read-model tables (CQRS).
 *
 * Mirrors SessionProjector. One `Layer.effectDiscard` that yields many
 * `events.project(...)` calls. Each projector runs INSIDE the durable publish
 * transaction — keep them to DB writes only (no external I/O, no heavy logic).
 *
 * Many events mutate the SAME row (e.g. every workflow.* event updates
 * WorkflowTable[id]); this is the standard CQRS pattern, NOT one-table-per-event.
 */

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    // ---- Workflow lifecycle ----

    yield* events.project(DagEvent.WorkflowCreated, (event) =>
      db
        .insert(WorkflowTable)
        .values({
          id: event.data.dagID,
          project_id: event.data.projectID,
          session_id: event.data.sessionID,
          title: event.data.title,
          status: event.data.status,
          config: event.data.config,
          seq: event.durable!.seq,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie),
    )

    const setWorkflowStatus = (status: WorkflowStatus, from: WorkflowStatus[]) => (event: { data: { dagID: DagEvent.DagID; timestamp: DateTime.Utc }; durable?: { seq: number } }) =>
      db
        .update(WorkflowTable)
        .set({ status, seq: event.durable!.seq, time_updated: toMillis(event.data.timestamp) })
        .where(and(eq(WorkflowTable.id, event.data.dagID), inArray(WorkflowTable.status, from)))
        .run()
        .pipe(Effect.orDie)

    yield* events.project(DagEvent.WorkflowStarted, (event) =>
      db
        .update(WorkflowTable)
        .set({
          status: "running",
          seq: event.durable!.seq,
          started_at: toMillis(event.data.timestamp),
          time_updated: toMillis(event.data.timestamp),
        })
        .where(and(eq(WorkflowTable.id, event.data.dagID), eq(WorkflowTable.status, "pending")))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.WorkflowPaused, setWorkflowStatus(ws("paused"), [ws("running"), ws("stepping")]))
    yield* events.project(DagEvent.WorkflowResumed, setWorkflowStatus(ws("running"), [ws("paused"), ws("stepping")]))
    yield* events.project(DagEvent.WorkflowStepped, setWorkflowStatus(ws("stepping"), [ws("running"), ws("stepping")]))

    const setWorkflowTerminal = (status: WorkflowStatus, from: WorkflowStatus[]) => (event: { data: { dagID: DagEvent.DagID; timestamp: DateTime.Utc }; durable?: { seq: number } }) =>
      db
        .update(WorkflowTable)
        .set({ status, seq: event.durable!.seq, completed_at: toMillis(event.data.timestamp), time_updated: toMillis(event.data.timestamp) })
        .where(and(eq(WorkflowTable.id, event.data.dagID), inArray(WorkflowTable.status, from)))
        .run()
        .pipe(Effect.orDie)

    yield* events.project(DagEvent.WorkflowCompleted, setWorkflowTerminal(ws("completed"), [ws("running"), ws("stepping")]))
    yield* events.project(DagEvent.WorkflowFailed, setWorkflowTerminal(ws("failed"), [ws("running"), ws("stepping")]))
    yield* events.project(DagEvent.WorkflowCancelled, setWorkflowTerminal(ws("cancelled"), [ws("running"), ws("paused"), ws("stepping")]))

    yield* events.project(DagEvent.WorkflowReplanned, (event) =>
      Effect.gen(function* () {
        // Atomic wake can reach the parent only after a leaf checkpoint has
        // completed the current graph. An additive extend emits this event to
        // reopen that completed workflow without changing completed nodes.
        yield* db
          .update(WorkflowTable)
          .set({
            status: "running",
            wake_reported: false,
            completed_at: null,
            seq: event.durable!.seq,
            time_updated: toMillis(event.data.timestamp),
          })
          .where(and(
            eq(WorkflowTable.id, event.data.dagID),
            eq(WorkflowTable.status, "completed"),
          ))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(WorkflowTable)
          .set({ seq: event.durable!.seq, time_updated: toMillis(event.data.timestamp) })
          .where(and(
            eq(WorkflowTable.id, event.data.dagID),
            inArray(WorkflowTable.status, ["pending", "running", "paused", "stepping"]),
          ))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    yield* events.project(DagEvent.WorkflowConfigUpdated, (event) =>
      db
        .update(WorkflowTable)
        .set({ config: event.data.config, seq: event.durable!.seq, time_updated: toMillis(event.data.timestamp) })
        .where(and(
          eq(WorkflowTable.id, event.data.dagID),
          inArray(WorkflowTable.status, ["pending", "running", "paused", "stepping", "completed"]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    // ---- Node lifecycle (insert on register, update thereafter) ----

    yield* events.project(DagEvent.NodeRegistered, (event) =>
      db
        .insert(WorkflowNodeTable)
        .values({
          id: event.data.nodeID,
          workflow_id: event.data.dagID,
          name: event.data.name,
          worker_type: event.data.workerType,
          status: "pending",
          required: event.data.required,
          depends_on: [...event.data.dependsOn],
          model_id: event.data.model?.modelID,
          model_provider_id: event.data.model?.providerID,
          seq: event.durable!.seq,
        })
        .onConflictDoUpdate({
          target: [WorkflowNodeTable.workflow_id, WorkflowNodeTable.id],
          set: {
            name: event.data.name,
            worker_type: event.data.workerType,
            required: event.data.required,
            depends_on: [...event.data.dependsOn],
            model_id: event.data.model?.modelID,
            model_provider_id: event.data.model?.providerID,
            seq: event.durable!.seq,
          },
        })
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeQueued, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          status: "queued",
          deadline_ms: event.data.deadlineMs ?? null,
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        // Admission is only valid from pending (fresh dispatch) or queued
        // (idempotent re-admission after crash recovery, P0-2). A concurrent
        // replan(cancel) terminalizing the node makes this a 0-row update.
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, ["pending", "queued"]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeStarted, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          status: "running",
          child_session_id: event.data.childSessionID,
          captured_output: null,
          started_at: toMillis(event.data.timestamp),
          deadline_ms: event.data.deadlineMs ?? null,
          wake_eligible: event.data.wakeEligible ?? false,
          wake_reported: false,
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        // Only start nodes in a pre-/in-running status. Prevents a stale or
        // racing NodeStarted (e.g. a spawn fiber resuming after a concurrent
        // replan(cancel) terminalized the node to "failed") from resurrecting
        // an already-terminal node back to "running". The legitimate restart
        // path goes NodeRestarted (running→pending) → re-spawn → NodeStarted
        // on the "pending" row, so excluding terminal statuses is safe.
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, ["pending", "queued", "paused", "running"]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeCompleted, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          status: "completed",
          output: event.data.output,
          completed_at: toMillis(event.data.timestamp),
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        // Only complete nodes in non-terminal status. Prevents a stale
        // NodeCompleted from flipping an already-terminal node (e.g. failed by
        // a replan-ceiling check) back to completed.
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, ["pending", "queued", "running", "paused"]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeFailed, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          status: "failed",
          error_reason: event.data.reason,
          completed_at: toMillis(event.data.timestamp),
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        // P1-7: only fail nodes in non-terminal status. Prevents stale
        // replan-ceiling events from overwriting completed/skipped nodes.
        // "queued" is included for the queue-wait timeout path (P0-2).
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, ["running", "pending", "queued"]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeSkipped, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          status: "skipped",
          error_reason: event.data.reason,
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, ["pending", "queued", "running", "paused"]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeCancelled, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({ status: "failed", error_reason: "cancelled via replan", seq: event.durable!.seq, time_updated: toMillis(event.data.timestamp) })
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          inArray(WorkflowNodeTable.status, ["pending", "queued", "running", "paused"]),
        ))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(DagEvent.NodeRestarted, (event) =>
      db
        .update(WorkflowNodeTable)
        .set({
          status: "pending",
          // P1-3: do NOT clear child_session_id here — spawnReady reads it to
          // abort the old session before spawning the replacement. NodeStarted
          // will overwrite it with the new child session.
          replan_attempts: sql`${WorkflowNodeTable.replan_attempts} + 1`,
          seq: event.durable!.seq,
          time_updated: toMillis(event.data.timestamp),
        })
        // Only restart nodes still in "running" status — if the node completed
        // or failed between replan's snapshot read and this event publish, the
        // UPDATE matches 0 rows and the terminal status is preserved.
        .where(and(
          eq(WorkflowNodeTable.workflow_id, event.data.dagID),
          eq(WorkflowNodeTable.id, event.data.nodeID),
          eq(WorkflowNodeTable.status, "running"),
        ))
        .run()
        .pipe(Effect.orDie),
    )
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))
export const node = LayerNode.make(layer, [EventV2.node, Database.node])
