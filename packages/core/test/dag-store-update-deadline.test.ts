import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowNodeTable, WorkflowTable } from "@opencode-ai/core/dag/sql"
import { DagStore } from "@opencode-ai/core/dag/store"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"

function storeLayer() {
  const database = Database.layerFromPath(":memory:")
  const store = DagStore.layer.pipe(Layer.provide(database))
  return Layer.merge(database, store)
}

function node(workflowId: string, id: string, status: string, seq: number) {
  return {
    id,
    workflow_id: workflowId,
    name: id,
    worker_type: "build",
    status,
    required: true,
    depends_on: [],
    wake_eligible: false,
    wake_reported: false,
    seq,
  }
}

function seed() {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.insert(ProjectTable).values({
      id: "project-1" as never,
      worktree: process.cwd() as never,
      sandboxes: [],
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values({
      id: "ses_parent" as never,
      project_id: "project-1" as never,
      slug: "parent",
      directory: process.cwd() as never,
      title: "Parent",
      version: "test",
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(WorkflowTable).values({
      id: "wf-1",
      project_id: "project-1" as never,
      session_id: "ses_parent" as never,
      title: "Deadline",
      status: "running",
      config: "{}",
      seq: 1,
      wake_reported: false,
      time_created: 1,
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(WorkflowNodeTable).values([
      { ...node("wf-1", "running-1", "running", 1), deadline_ms: 1000, timeout_extensions: 1, escalation_pending: true },
      { ...node("wf-1", "done-1", "completed", 2), deadline_ms: 2000, timeout_extensions: 1, escalation_pending: true },
    ]).run().pipe(Effect.orDie)
  })
}

describe("DagStore.updateNodeDeadline (adjudication write)", () => {
  test("writes one row for a running node: moves the deadline, clears escalation_pending, consumes the escalation wake, keeps the cumulative count", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seed()

        const written = yield* store.updateNodeDeadline("wf-1", "running-1", 99_999)
        expect(written).toBe(1)

        const row = yield* store.getNode("wf-1", "running-1")
        expect(row?.deadlineMs).toBe(99_999)
        expect(row?.escalationPending).toBe(false)
        expect(row?.wakeReported).toBe(true)
        expect(row?.timeoutExtensions).toBe(1)
      }).pipe(Effect.provide(storeLayer()), Effect.scoped),
    )
  })

  test("rejects a terminal node: zero rows written, deadline untouched (status='running' guard)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seed()

        const written = yield* store.updateNodeDeadline("wf-1", "done-1", 99_999)
        expect(written).toBe(0)

        const row = yield* store.getNode("wf-1", "done-1")
        expect(row?.deadlineMs).toBe(2000)
        expect(row?.escalationPending).toBe(true)
        expect(row?.timeoutExtensions).toBe(1)
      }).pipe(Effect.provide(storeLayer()), Effect.scoped),
    )
  })
})
