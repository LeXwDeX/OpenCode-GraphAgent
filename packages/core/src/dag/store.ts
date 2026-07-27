export * as DagStore from "./store"

import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"
import { WorkflowNodeTable, WorkflowTable } from "./sql"

// ============================================================================
// Row → domain types
// ============================================================================

export interface WorkflowRow {
  id: string
  projectId: string
  sessionId: string
  title: string
  status: string
  config: string
  seq: number
  wakeReported: boolean
  startedAt: number | null
  completedAt: number | null
  timeCreated: number
  timeUpdated: number
}

export interface NodeRow {
  id: string
  workflowId: string
  name: string
  workerType: string
  status: string
  required: boolean
  dependsOn: string[]
  modelId: string | null
  modelProviderId: string | null
  childSessionId: string | null
  output: unknown
  capturedOutput: unknown
  errorReason: string | null
  deadlineMs: number | null
  wakeEligible: boolean
  wakeReported: boolean
  replanAttempts: number
  seq: number
  startedAt: number | null
  completedAt: number | null
}

export interface WakeBatch {
  readonly nodes: readonly NodeRow[]
  readonly workflows: readonly WorkflowRow[]
}

export interface WakeSnapshot {
  readonly nodes: readonly NodeRow[]
  readonly workflows: readonly WorkflowRow[]
}

/** Aggregated per-workflow progress for UI display. Shape matches the TUI's DagWorkflowSummary. */
export interface WorkflowSummary {
  id: string
  title: string
  status: string
  nodeCount: number
  completedNodes: number
  runningNodes: number
  failedNodes: number
}

const mapWorkflow = (r: typeof WorkflowTable.$inferSelect): WorkflowRow => ({
  id: r.id,
  projectId: r.project_id,
  sessionId: r.session_id,
  title: r.title,
  status: r.status,
  config: r.config,
  seq: r.seq,
  wakeReported: r.wake_reported,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  timeCreated: r.time_created,
  timeUpdated: r.time_updated,
})

const mapNode = (r: typeof WorkflowNodeTable.$inferSelect): NodeRow => ({
  id: r.id,
  workflowId: r.workflow_id,
  name: r.name,
  workerType: r.worker_type,
  status: r.status,
  required: r.required,
  dependsOn: r.depends_on,
  modelId: r.model_id,
  modelProviderId: r.model_provider_id,
  childSessionId: r.child_session_id,
  output: r.output,
  capturedOutput: r.captured_output,
  errorReason: r.error_reason,
  deadlineMs: r.deadline_ms,
  wakeEligible: r.wake_eligible,
  wakeReported: r.wake_reported,
  replanAttempts: r.replan_attempts,
  seq: r.seq,
  startedAt: r.started_at,
  completedAt: r.completed_at,
})

// ============================================================================
// Service interface
// ============================================================================

export interface Interface {
  readonly getWorkflow: (id: string) => Effect.Effect<WorkflowRow | undefined>
  readonly listWorkflows: () => Effect.Effect<WorkflowRow[]>
  readonly listBySession: (sessionId: string) => Effect.Effect<WorkflowRow[]>
  readonly listByProject: (projectId: string) => Effect.Effect<WorkflowRow[]>
  readonly listByStatus: (status: string) => Effect.Effect<WorkflowRow[]>
  readonly getWorkflowSummaries: (sessionId: string) => Effect.Effect<WorkflowSummary[]>

  readonly getNodes: (workflowId: string) => Effect.Effect<NodeRow[]>
  readonly getNode: (workflowId: string, nodeId: string) => Effect.Effect<NodeRow | undefined>
  readonly getRunningNodes: (workflowId: string) => Effect.Effect<NodeRow[]>
  readonly setCapturedOutput: (childSessionID: string, payload: unknown) => Effect.Effect<void>

  readonly markNodeWakeReported: (workflowId: string, nodeID: string) => Effect.Effect<void>
  readonly markWorkflowWakeReported: (dagID: string) => Effect.Effect<void>
  readonly markWakeBatchReported: (batch: WakeBatch) => Effect.Effect<void>
  readonly getWakeSnapshot: (sessionID: string) => Effect.Effect<WakeSnapshot>
  readonly getUnreportedWakeNodes: (sessionID: string) => Effect.Effect<NodeRow[]>
  readonly getUnreportedWakeWorkflows: (sessionID: string) => Effect.Effect<WorkflowRow[]>
  readonly getSessionsWithUnreportedWakes: () => Effect.Effect<string[]>
  readonly hasReportedWakeNodes: (sessionID: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/DagStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return Service.of({
      getWorkflow: Effect.fn("DagStore.getWorkflow")(function* (id) {
        const row = yield* db.select().from(WorkflowTable).where(eq(WorkflowTable.id, id)).get().pipe(Effect.orDie)
        return row ? mapWorkflow(row) : undefined
      }),

      listWorkflows: Effect.fn("DagStore.listWorkflows")(function* () {
        const rows = yield* db.select().from(WorkflowTable).orderBy(desc(WorkflowTable.time_created)).all().pipe(Effect.orDie)
        return rows.map(mapWorkflow)
      }),

      listBySession: Effect.fn("DagStore.listBySession")(function* (sessionId) {
        const rows = yield* db
          .select()
          .from(WorkflowTable)
          .where(eq(WorkflowTable.session_id, sessionId))
          .orderBy(desc(WorkflowTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapWorkflow)
      }),

      listByProject: Effect.fn("DagStore.listByProject")(function* (projectId) {
        const rows = yield* db
          .select()
          .from(WorkflowTable)
          .where(eq(WorkflowTable.project_id, projectId))
          .orderBy(desc(WorkflowTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapWorkflow)
      }),

      listByStatus: Effect.fn("DagStore.listByStatus")(function* (status) {
        const rows = yield* db
          .select()
          .from(WorkflowTable)
          .where(eq(WorkflowTable.status, status))
          .orderBy(desc(WorkflowTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapWorkflow)
      }),

      getWorkflowSummaries: Effect.fn("DagStore.getWorkflowSummaries")(function* (sessionId) {
        const wfRows = yield* db
          .select()
          .from(WorkflowTable)
          .where(eq(WorkflowTable.session_id, sessionId))
          .orderBy(desc(WorkflowTable.time_created))
          .all()
          .pipe(Effect.orDie)
        if (wfRows.length === 0) return []
        const nodeRows = yield* db
          .select({ workflowId: WorkflowNodeTable.workflow_id, status: WorkflowNodeTable.status })
          .from(WorkflowNodeTable)
          .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
          .where(eq(WorkflowTable.session_id, sessionId))
          .all()
          .pipe(Effect.orDie)
        const counts = nodeRows.reduce((all, node) => {
          const current = all.get(node.workflowId) ?? { nodeCount: 0, completedNodes: 0, runningNodes: 0, failedNodes: 0 }
          current.nodeCount++
          if (node.status === "completed") current.completedNodes++
          if (node.status === "running") current.runningNodes++
          if (node.status === "failed") current.failedNodes++
          all.set(node.workflowId, current)
          return all
        }, new Map<string, { nodeCount: number; completedNodes: number; runningNodes: number; failedNodes: number }>())
        return wfRows.map((wf) => ({
          id: wf.id,
          title: wf.title,
          status: wf.status,
          ...(counts.get(wf.id) ?? { nodeCount: 0, completedNodes: 0, runningNodes: 0, failedNodes: 0 }),
        }))
      }),

      getNodes: Effect.fn("DagStore.getNodes")(function* (workflowId) {
        const rows = yield* db
          .select()
          .from(WorkflowNodeTable)
          .where(eq(WorkflowNodeTable.workflow_id, workflowId))
          .orderBy(desc(WorkflowNodeTable.seq))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapNode)
      }),

      getNode: Effect.fn("DagStore.getNode")(function* (workflowId, nodeId) {
        const row = yield* db
          .select()
          .from(WorkflowNodeTable)
          .where(and(eq(WorkflowNodeTable.workflow_id, workflowId), eq(WorkflowNodeTable.id, nodeId)))
          .get()
          .pipe(Effect.orDie)
        return row ? mapNode(row) : undefined
      }),

      getRunningNodes: Effect.fn("DagStore.getRunningNodes")(function* (workflowId) {
        const rows = yield* db
          .select()
          .from(WorkflowNodeTable)
          .where(and(eq(WorkflowNodeTable.workflow_id, workflowId), eq(WorkflowNodeTable.status, "running")))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapNode)
      }),

      setCapturedOutput: Effect.fn("DagStore.setCapturedOutput")(function* (childSessionID, payload) {
        yield* db
          .update(WorkflowNodeTable)
          .set({ captured_output: payload })
          .where(eq(WorkflowNodeTable.child_session_id, childSessionID))
          .run()
          .pipe(Effect.orDie)
      }),

      markNodeWakeReported: Effect.fn("DagStore.markNodeWakeReported")(function* (workflowId, nodeID) {
        yield* db
          .update(WorkflowNodeTable)
          .set({ wake_reported: true })
          .where(and(eq(WorkflowNodeTable.workflow_id, workflowId), eq(WorkflowNodeTable.id, nodeID)))
          .run()
          .pipe(Effect.orDie)
      }),

      markWorkflowWakeReported: Effect.fn("DagStore.markWorkflowWakeReported")(function* (dagID) {
        yield* db
          .update(WorkflowTable)
          .set({ wake_reported: true })
          .where(eq(WorkflowTable.id, dagID))
          .run()
          .pipe(Effect.orDie)
      }),

      markWakeBatchReported: Effect.fn("DagStore.markWakeBatchReported")(function* (batch) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* Effect.forEach(
                batch.nodes,
                (node) =>
                  tx
                    .update(WorkflowNodeTable)
                    .set({ wake_reported: true })
                    .where(and(
                      eq(WorkflowNodeTable.workflow_id, node.workflowId),
                      eq(WorkflowNodeTable.id, node.id),
                      eq(WorkflowNodeTable.seq, node.seq),
                      eq(WorkflowNodeTable.wake_reported, false),
                    ))
                    .run(),
                { discard: true },
              )
              yield* Effect.forEach(
                batch.workflows,
                (workflow) =>
                  tx
                    .update(WorkflowTable)
                    .set({ wake_reported: true })
                    .where(and(
                      eq(WorkflowTable.id, workflow.id),
                      eq(WorkflowTable.seq, workflow.seq),
                      eq(WorkflowTable.wake_reported, false),
                    ))
                    .run(),
                { discard: true },
              )
            }),
          )
          .pipe(Effect.orDie)
      }),

      getWakeSnapshot: Effect.fn("DagStore.getWakeSnapshot")(function* (sessionID) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const nodes = yield* tx
                .select()
                .from(WorkflowNodeTable)
                .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
                .where(and(
                  eq(WorkflowTable.session_id, sessionID),
                  eq(WorkflowNodeTable.wake_eligible, true),
                  eq(WorkflowNodeTable.wake_reported, false),
                  inArray(WorkflowNodeTable.status, ["completed", "failed"]),
                ))
                .orderBy(
                  asc(WorkflowTable.seq),
                  asc(WorkflowTable.id),
                  asc(WorkflowNodeTable.seq),
                  asc(WorkflowNodeTable.id),
                )
                .all()
              const workflows = yield* tx
                .select()
                .from(WorkflowTable)
                .where(eq(WorkflowTable.session_id, sessionID))
                .orderBy(asc(WorkflowTable.seq), asc(WorkflowTable.id))
                .all()
              return {
                nodes: nodes.map((row) => mapNode(row.workflow_node)),
                workflows: workflows.map(mapWorkflow),
              }
            }),
          )
          .pipe(Effect.orDie)
      }),

      getUnreportedWakeNodes: Effect.fn("DagStore.getUnreportedWakeNodes")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(WorkflowNodeTable)
          .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
          .where(and(
            eq(WorkflowTable.session_id, sessionID),
            eq(WorkflowNodeTable.wake_eligible, true),
            eq(WorkflowNodeTable.wake_reported, false),
            inArray(WorkflowNodeTable.status, ["completed", "failed"]),
          ))
          .orderBy(
            asc(WorkflowTable.seq),
            asc(WorkflowTable.id),
            asc(WorkflowNodeTable.seq),
            asc(WorkflowNodeTable.id),
          )
          .all()
          .pipe(Effect.orDie)
        return rows.map((r) => mapNode(r.workflow_node))
      }),

      getUnreportedWakeWorkflows: Effect.fn("DagStore.getUnreportedWakeWorkflows")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(WorkflowTable)
          .where(and(
            eq(WorkflowTable.session_id, sessionID),
            eq(WorkflowTable.wake_reported, false),
          ))
          .orderBy(asc(WorkflowTable.seq), asc(WorkflowTable.id))
          .all()
          .pipe(Effect.orDie)
        return rows
          .filter((r) => ["completed", "failed", "cancelled"].includes(r.status))
          .map(mapWorkflow)
      }),

      getSessionsWithUnreportedWakes: Effect.fn("DagStore.getSessionsWithUnreportedWakes")(function* () {
        const workflowRows = yield* db
          .select({ sessionId: WorkflowTable.session_id })
          .from(WorkflowTable)
          .where(and(
            eq(WorkflowTable.wake_reported, false),
            inArray(WorkflowTable.status, ["completed", "failed", "cancelled"]),
          ))
          .all()
          .pipe(Effect.orDie)
        const nodeRows = yield* db
          .select({ sessionId: WorkflowTable.session_id })
          .from(WorkflowNodeTable)
          .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
          .where(and(
            eq(WorkflowNodeTable.wake_eligible, true),
            eq(WorkflowNodeTable.wake_reported, false),
            inArray(WorkflowNodeTable.status, ["completed", "failed"]),
          ))
          .all()
          .pipe(Effect.orDie)
        return [...new Set([...workflowRows, ...nodeRows].map((row) => row.sessionId))]
      }),

      hasReportedWakeNodes: Effect.fn("DagStore.hasReportedWakeNodes")(function* (sessionID) {
        const rows = yield* db
          .select({ id: WorkflowNodeTable.id })
          .from(WorkflowNodeTable)
          .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
          .where(and(
            eq(WorkflowTable.session_id, sessionID),
            eq(WorkflowNodeTable.wake_eligible, true),
            eq(WorkflowNodeTable.wake_reported, true),
          ))
          .all()
          .pipe(Effect.orDie)
        return rows.length > 0
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [Database.node])
