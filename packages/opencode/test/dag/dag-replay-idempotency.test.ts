import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable, EventSequenceTable } from "@opencode-ai/core/event/sql"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"

const projectorLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
)

const ts = (n: number) => DateTime.makeUnsafe(n)

function setupFKs() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: "ses_replay" as never, project_id: Project.ID.global, slug: "replay", directory: "/project", title: "replay", version: "test" }).run().pipe(Effect.orDie)
  })
}

function serializeAndWipe(dagID: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(EventTable)
      .where(sql`${EventTable.aggregate_id} = ${dagID}`)
      .orderBy(EventTable.seq)
      .all()
      .pipe(Effect.orDie)
    const serialized = rows.map((r) => ({
      id: r.id as EventV2.ID,
      type: r.type,
      seq: r.seq,
      aggregateID: r.aggregate_id,
      data: r.data as Record<string, unknown>,
    }))
    yield* db.delete(EventTable).where(sql`${EventTable.aggregate_id} = ${dagID}`).run().pipe(Effect.orDie)
    yield* db.delete(EventSequenceTable).where(sql`${EventSequenceTable.aggregate_id} = ${dagID}`).run().pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM workflow_node WHERE workflow_id = ${dagID}`).pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM workflow WHERE id = ${dagID}`).pipe(Effect.orDie)
    return serialized
  })
}

function snapshotState(dagID: string, nodeIDs: string[]) {
  return Effect.gen(function* () {
    const store = yield* DagStore.Service
    const wf = yield* store.getWorkflow(dagID)
    const nodes = yield* Effect.forEach(nodeIDs, (id) => store.getNode(dagID, id))
    return {
      workflowStatus: wf?.status,
      nodes: nodes.map((n) => ({
        id: n?.id,
        status: n?.status,
        output: n?.output ?? null,
        capturedOutput: n?.capturedOutput ?? null,
        replanAttempts: n?.replanAttempts ?? 0,
        childSessionId: n?.childSessionId ?? null,
      })),
    }
  })
}

describe("DagProjector: replay idempotency", () => {
  it("normal completion flow produces identical read-model on replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const events = yield* EventV2.Service
        const dagID = "dag_replay_complete" as never

        yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global as never, sessionID: "ses_replay" as never, title: "replay-test", config: "{}", status: "pending", timestamp: ts(0) })
        yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID: "a" as never, name: "A", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
        yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: "a" as never, childSessionID: "ses_child" as never, timestamp: ts(3) })
        yield* events.publish(DagEvent.NodeCompleted, { dagID, nodeID: "a" as never, output: "done", durationMs: 0, timestamp: ts(4) })
        yield* events.publish(DagEvent.WorkflowCompleted, { dagID, durationMs: 0, timestamp: ts(5) })

        const original = yield* snapshotState(dagID, ["a"])
        const serialized = yield* serializeAndWipe(dagID)
        yield* events.replayAll(serialized)
        const replayed = yield* snapshotState(dagID, ["a"])

        expect(replayed).toEqual(original)
        expect(replayed.workflowStatus).toBe("completed")
        expect(replayed.nodes[0]?.status).toBe("completed")
        expect(replayed.nodes[0]?.output).toBe("done")
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })

  it("cancellation flow produces identical read-model on replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const events = yield* EventV2.Service
        const dagID = "dag_replay_cancel" as never

        yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global as never, sessionID: "ses_replay" as never, title: "cancel-test", config: "{}", status: "pending", timestamp: ts(0) })
        yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID: "a" as never, name: "A", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
        yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: "a" as never, childSessionID: "ses_child" as never, timestamp: ts(3) })
        yield* events.publish(DagEvent.WorkflowCancelled, { dagID, timestamp: ts(4) })
        yield* events.publish(DagEvent.NodeSkipped, { dagID, nodeID: "a" as never, reason: "workflow_cancelled", timestamp: ts(5) })

        const original = yield* snapshotState(dagID, ["a"])
        const serialized = yield* serializeAndWipe(dagID)
        yield* events.replayAll(serialized)
        const replayed = yield* snapshotState(dagID, ["a"])

        expect(replayed).toEqual(original)
        expect(replayed.workflowStatus).toBe("cancelled")
        expect(replayed.nodes[0]?.status).toBe("skipped")
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })

  it("stale NodeStarted after NodeCancelled is rejected on replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const events = yield* EventV2.Service
        const dagID = "dag_replay_stale" as never

        yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global as never, sessionID: "ses_replay" as never, title: "stale-test", config: "{}", status: "pending", timestamp: ts(0) })
        yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID: "a" as never, name: "A", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
        yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: "a" as never, childSessionID: "ses_A" as never, timestamp: ts(3) })
        yield* events.publish(DagEvent.NodeCancelled, { dagID, nodeID: "a" as never, timestamp: ts(4) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: "a" as never, childSessionID: "ses_B" as never, timestamp: ts(5) })

        const original = yield* snapshotState(dagID, ["a"])
        const serialized = yield* serializeAndWipe(dagID)
        yield* events.replayAll(serialized)
        const replayed = yield* snapshotState(dagID, ["a"])

        expect(replayed).toEqual(original)
        expect(replayed.nodes[0]?.status).toBe("failed")
        expect(replayed.nodes[0]?.childSessionId).toBe("ses_A")
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })

  it("replan restart preserves replan_attempts on replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const events = yield* EventV2.Service
        const dagID = "dag_replay_restart" as never

        yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global as never, sessionID: "ses_replay" as never, title: "restart-test", config: "{}", status: "pending", timestamp: ts(0) })
        yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID: "a" as never, name: "A", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
        yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: "a" as never, childSessionID: "ses_A" as never, timestamp: ts(3) })
        yield* events.publish(DagEvent.NodeRestarted, { dagID, nodeID: "a" as never, childSessionID: "ses_A" as never, timestamp: ts(4) })
        yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: "a" as never, childSessionID: "ses_B" as never, timestamp: ts(5) })
        yield* events.publish(DagEvent.NodeCompleted, { dagID, nodeID: "a" as never, output: "restarted-done", durationMs: 0, timestamp: ts(6) })
        yield* events.publish(DagEvent.WorkflowCompleted, { dagID, durationMs: 0, timestamp: ts(7) })

        const original = yield* snapshotState(dagID, ["a"])
        const serialized = yield* serializeAndWipe(dagID)
        yield* events.replayAll(serialized)
        const replayed = yield* snapshotState(dagID, ["a"])

        expect(replayed).toEqual(original)
        expect(replayed.nodes[0]?.status).toBe("completed")
        expect(replayed.nodes[0]?.replanAttempts).toBe(1)
        expect(replayed.nodes[0]?.output).toBe("restarted-done")
      }).pipe(Effect.provide(projectorLayer)) as Effect.Effect<never>,
    )
  })
})
