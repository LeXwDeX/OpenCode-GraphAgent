import { describe, expect, test } from "bun:test"
import path from "path"
import { sql } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowNodeTable, WorkflowTable } from "@opencode-ai/core/dag/sql"
import { DagStore } from "@opencode-ai/core/dag/store"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { tmpdir } from "./fixture/tmpdir"

function storeLayer(filename: string) {
  const database = Database.layerFromPath(filename)
  const store = DagStore.layer.pipe(Layer.provide(database))
  return Layer.merge(database, store)
}

function seedBatch() {
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
      title: "Batch",
      status: "completed",
      config: "{}",
      seq: 4,
      wake_reported: false,
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(WorkflowNodeTable).values([
      {
        id: "a",
        workflow_id: "wf-1",
        name: "A",
        worker_type: "build",
        status: "completed",
        required: true,
        depends_on: [],
        output: "A",
        wake_eligible: true,
        wake_reported: false,
        seq: 2,
      },
      {
        id: "b",
        workflow_id: "wf-1",
        name: "B",
        worker_type: "build",
        status: "completed",
        required: true,
        depends_on: [],
        output: "B",
        wake_eligible: true,
        wake_reported: false,
        seq: 3,
      },
    ]).run().pipe(Effect.orDie)
  })
}

function acknowledgeBatch(store: DagStore.Interface) {
  return Effect.gen(function* () {
    const nodes = yield* store.getUnreportedWakeNodes("ses_parent")
    const workflows = yield* store.getUnreportedWakeWorkflows("ses_parent")
    yield* store.markWakeBatchReported({ nodes, workflows })
  })
}

describe("DagStore wake batch", () => {
  test("atomically marks every included node and workflow reported", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seedBatch()

        yield* acknowledgeBatch(store)

        expect(yield* store.getUnreportedWakeNodes("ses_parent")).toEqual([])
        expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toEqual([])
      }).pipe(
        Effect.provide(storeLayer(":memory:")),
        Effect.scoped,
      ),
    )
  })

  test("rolls back the whole batch when one acknowledgement update fails", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const store = yield* DagStore.Service
        yield* seedBatch()
        yield* database.db.run(sql`
          CREATE TRIGGER reject_workflow_wake
          BEFORE UPDATE OF wake_reported ON workflow
          WHEN NEW.id = 'wf-1' AND NEW.wake_reported = 1
          BEGIN
            SELECT RAISE(ABORT, 'forced acknowledgement failure');
          END
        `).pipe(Effect.orDie)

        expect(Exit.isFailure(yield* Effect.exit(acknowledgeBatch(store)))).toBe(true)
        expect(yield* store.getUnreportedWakeNodes("ses_parent")).toHaveLength(2)
        expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toHaveLength(1)
      }).pipe(
        Effect.provide(storeLayer(":memory:")),
        Effect.scoped,
      ),
    )
  })

  test("does not acknowledge a newer attempt that reused the same node ID", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const store = yield* DagStore.Service
        yield* seedBatch()
        const batch = yield* store.getWakeSnapshot("ses_parent")
        const original = batch.nodes.find((node) => node.id === "a")!
        yield* database.db
          .update(WorkflowNodeTable)
          .set({ seq: original.seq + 10, output: "new attempt", wake_reported: false })
          .where(sql`${WorkflowNodeTable.workflow_id} = 'wf-1' AND ${WorkflowNodeTable.id} = 'a'`)
          .run()
          .pipe(Effect.orDie)

        yield* store.markWakeBatchReported({
          nodes: batch.nodes,
          workflows: batch.workflows.filter((workflow) => !workflow.wakeReported),
        })

        expect((yield* store.getUnreportedWakeNodes("ses_parent")).map((node) => node.output)).toEqual([
          "new attempt",
        ])
      }).pipe(
        Effect.provide(storeLayer(":memory:")),
        Effect.scoped,
      ),
    )
  })

  test("discovers the full unacknowledged batch after reopening the database", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "dag-wake.sqlite")
    await Effect.runPromise(
      seedBatch().pipe(
        Effect.provide(storeLayer(filename)),
        Effect.scoped,
      ),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        expect(yield* store.getUnreportedWakeNodes("ses_parent")).toHaveLength(2)
        expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toHaveLength(1)
        expect(yield* store.getSessionsWithUnreportedWakes()).toEqual(["ses_parent"])
      }).pipe(
        Effect.provide(storeLayer(filename)),
        Effect.scoped,
      ),
    )
  })
})
