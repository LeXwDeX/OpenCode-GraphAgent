/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Synthetic branded DB rows and Session service mocks exercise transaction rollback without starting a model. */
import { expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@opencode-ai/core/dag/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "@/session/session"
import { deliverReport, reportIdentity, selectReportNode } from "@/dag/runtime/report-delivery"
import { commitOutputFileRef, verifyOutputFileRef } from "@/dag/runtime/output-ref"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"
import { WorkflowAuthoring } from "@/dag/authoring"
import { parseWorkflowConfig, resultProtocol } from "@/dag/dag"
import { before } from "@/session/message-v2"

function fixture(
  work: (input: {
    database: Database.Interface
    store: DagStore.Interface
    sessions: Session.Interface
    workflow: DagStore.WorkflowRow
    deliver: () => Effect.Effect<boolean, never, Database.Service>
    crash: (value: boolean) => void
  }) => Effect.Effect<unknown, unknown, Database.Service>,
) {
  const database = Database.layerFromPath(":memory:")
  const layer = Layer.merge(database, DagStore.layer.pipe(Layer.provide(database)))
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const store = yield* DagStore.Service
    const db = database.db
    const text = "  Exact final report\n\nwith **formatting** and trailing space.  "
    const config = {
      name: "delivery",
      result_protocol: "final_response",
      delivery_node: "final",
      nodes: [{ id: "final", depends_on: [] }],
    }
    yield* db
      .insert(ProjectTable)
      .values({ id: "proj-1" as never, worktree: "/tmp" as never, sandboxes: [], time_created: 1, time_updated: 1 })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: "ses_parent" as never,
        project_id: "proj-1" as never,
        directory: "/tmp",
        title: "parent",
        slug: "parent",
        version: "test",
        time_created: 1,
        time_updated: 1,
      })
      .run()
    yield* db
      .insert(WorkflowTable)
      .values({
        id: "wf-1",
        project_id: "proj-1" as never,
        session_id: "ses_parent" as never,
        title: "delivery",
        status: "completed",
        config: JSON.stringify(config),
        graph_rev: 2,
        seq: 7,
        completed_at: 100,
        time_created: 1,
        time_updated: 100,
      })
      .run()
    yield* db
      .insert(WorkflowNodeTable)
      .values({
        workflow_id: "wf-1",
        id: "final",
        name: "Final",
        worker_type: "general",
        status: "completed",
        depends_on: [],
        output: text,
        seq: 6,
        child_session_id: "ses_child",
        time_created: 1,
        time_updated: 100,
      })
      .run()
    const workflow = (yield* store.getWorkflow("wf-1"))!
    let fail = false
    const sessions = {
      get: () => Effect.succeed({ id: "ses_parent", agent: "build", model: { providerID: "test", id: "test-model" } }),
      messages: () =>
        db
          .select()
          .from(MessageTable)
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => ({ info: { ...row.data, id: row.id, sessionID: row.session_id }, parts: [] })),
            ),
          ),
      getPart: (input: { partID: string }) =>
        db
          .select()
          .from(PartTable)
          .where(eq(PartTable.id, input.partID as never))
          .pipe(
            Effect.map((rows) =>
              rows[0]
                ? { ...rows[0].data, id: rows[0].id, sessionID: rows[0].session_id, messageID: rows[0].message_id }
                : undefined,
            ),
          ),
      updateMessage: (info: SessionV1.Info) => {
        const { id, sessionID, ...data } = info
        return db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, data, time_created: info.time.created, time_updated: info.time.created })
          .run()
          .pipe(Effect.as(info))
      },
      updatePart: (part: SessionV1.Part) => {
        if (fail && part.type === "text" && part.metadata?.dag_delivery?.kind === "answer")
          return Effect.die(new Error("simulated process failure before receipt"))
        const { id, sessionID, messageID, ...data } = part
        return db
          .insert(PartTable)
          .values({ id, session_id: sessionID, message_id: messageID, data, time_created: 100, time_updated: 100 })
          .run()
          .pipe(Effect.as(part))
      },
    } as unknown as Session.Interface
    const deliver = () =>
      Effect.gen(function* () {
        const nodes = yield* store.getCurrentNodes("wf-1")
        return yield* deliverReport({
          workflow,
          store,
          sessions,
          directory: "/tmp",
          batch: { nodes, workflows: [workflow] },
        })
      }).pipe(Effect.orDie)
    yield* work({
      database,
      store,
      sessions,
      workflow,
      deliver,
      crash: (value) => {
        fail = value
      },
    })
  }).pipe(Effect.provide(layer), Effect.runPromise)
}

it("copies the answer verbatim with source metadata and adopts the same receipt after restart", () =>
  fixture(({ database, store, workflow, deliver }) =>
    Effect.gen(function* () {
      expect(yield* deliver()).toBe(true)
      const first = yield* database.db.select().from(PartTable)
      const answers = first.filter(
        (part) =>
          part.data.type === "text" && (part.data as SessionV1.TextPart).metadata?.dag_delivery?.kind === "answer",
      )
      expect(answers).toHaveLength(1)
      expect((answers[0].data as SessionV1.TextPart).text).toBe(
        "  Exact final report\n\nwith **formatting** and trailing space.  ",
      )
      expect(answers[0].id).toBe(reportIdentity(workflow).answerID)
      expect((answers[0].data as SessionV1.TextPart).time?.end).toBe(100)
      expect(reportIdentity(workflow).sourceID < reportIdentity(workflow).answerID).toBe(true)
      expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(true)
      // Reconstructed callers have no in-memory receipt cache. A durable receipt
      // still suppresses re-insertion if an old wake flag needs re-acknowledging.
      yield* database.db.update(WorkflowTable).set({ wake_reported: false }).where(eq(WorkflowTable.id, "wf-1")).run()
      expect(yield* deliver()).toBe(true)
      expect(yield* database.db.select().from(PartTable)).toHaveLength(first.length)
      expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(true)
    }),
  ))

it("rolls back the entire transcript and wake mark when receipt persistence fails", () =>
  fixture(({ database, store, deliver, crash }) =>
    Effect.gen(function* () {
      crash(true)
      expect((yield* deliver().pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* database.db.select().from(MessageTable)).toHaveLength(0)
      expect(yield* database.db.select().from(PartTable)).toHaveLength(0)
      expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(false)
      crash(false)
      expect(yield* deliver()).toBe(true)
      expect(
        (yield* database.db.select().from(MessageTable)).filter((row) => row.data.role === "assistant"),
      ).toHaveLength(1)
    }),
  ))

it("does not copy a completion superseded by a reopen or a newer graph revision", () =>
  fixture(({ database, deliver }) =>
    Effect.gen(function* () {
      yield* database.db
        .update(WorkflowTable)
        .set({ status: "running", seq: 8, graph_rev: 3 })
        .where(eq(WorkflowTable.id, "wf-1"))
        .run()
      expect(yield* deliver()).toBe(false)
      expect(yield* database.db.select().from(MessageTable)).toHaveLength(0)
    }),
  ))

it("rejects a mismatched durable receipt instead of acknowledging lost content", () =>
  fixture(({ database, store, workflow, deliver }) =>
    Effect.gen(function* () {
      yield* deliver()
      const id = reportIdentity(workflow).answerID
      const part = (yield* database.db.select().from(PartTable).where(eq(PartTable.id, id)))[0]
      yield* database.db
        .update(PartTable)
        .set({ data: { ...part.data, text: "tampered" } as never })
        .where(eq(PartTable.id, id))
        .run()
      yield* database.db.update(WorkflowTable).set({ wake_reported: false }).where(eq(WorkflowTable.id, "wf-1")).run()
      expect((yield* deliver().pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(false)
    }),
  ))

it("uses explicit delivery selection and never guesses from required nodes or old attempts", () => {
  const nodes = [
    makeNodeRow({ id: "required", required: true, status: "completed" }),
    makeNodeRow({ id: "final", status: "completed", superseded: true }),
  ]
  expect(selectReportNode({ name: "ambiguous", nodes: [] }, nodes)).toBeUndefined()
  expect(selectReportNode({ name: "old", nodes: [], delivery_node: "final" }, nodes)).toBeUndefined()
  expect(reportIdentity(makeWorkflowRow({ seq: 2 }))).not.toEqual(reportIdentity(makeWorkflowRow({ seq: 3 })))
})

it("persists the unique leaf synthesis selection and preserves the legacy protocol default", async () => {
  const authoring = WorkflowAuthoring.make()
  const result = await Effect.runPromise(authoring.prepare({ action: "start", profile: "portable", source: { kind: "inline", value: { config: { name: "synthesis", objective: "Produce the final report", blocks: [{ id: "final", kind: "synthesize" }] } } } }))
  expect(result.valid).toBe(true)
  expect(result.prepared?.action === "start" && result.prepared.config.delivery_node).toBe("final")
  const ambiguous = await Effect.runPromise(authoring.prepare({ action: "start", profile: "portable", source: { kind: "inline", value: { config: { name: "ambiguous", objective: "Produce reports", blocks: [{ id: "a", kind: "synthesize" }, { id: "b", kind: "synthesize" }] } } } }))
  expect(ambiguous.prepared?.action === "start" && ambiguous.prepared.config.delivery_node).toBeUndefined()
  const invalid = await Effect.runPromise(authoring.prepare({ action: "start", profile: "portable", source: { kind: "inline", value: { config: { name: "invalid", delivery_node: "missing", nodes: [{ id: "a", name: "A", worker_type: "general", depends_on: [], prompt_template: { inline: "A" } }] } } } }))
  expect(invalid.valid).toBe(false)
  expect(resultProtocol(parseWorkflowConfig(JSON.stringify({ name: "legacy", nodes: [] })))).toBe("submit_result")
  expect(parseWorkflowConfig(JSON.stringify({ name: "bad", nodes: [], result_protocol: "unknown" }))).toBeUndefined()
})

it("preserves an unprocessed user request while idle and delivers after it has an answer", () =>
  fixture(({ database, sessions, deliver }) =>
    Effect.gen(function* () {
      yield* sessions.updateMessage({
        id: "msg_pending" as never,
        sessionID: "ses_parent" as never,
        role: "user",
        time: { created: 50 },
        agent: "build",
        model: { providerID: "test" as never, modelID: "test" as never },
      })
      expect(yield* deliver()).toBe(false)
      expect(
        (yield* database.db.select().from(MessageTable)).filter((row) => row.data.role === "assistant"),
      ).toHaveLength(0)
      yield* sessions.updateMessage({
        id: "msg_answered" as never,
        sessionID: "ses_parent" as never,
        parentID: "msg_pending" as never,
        role: "assistant",
        time: { created: 60, completed: 60 },
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        providerID: "test" as never,
        modelID: "test" as never,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      })
      expect(yield* deliver()).toBe(true)
    }),
  ))

it("stores an oversized answer as a verified artifact with bounded parent text", () =>
  fixture(({ database, deliver }) =>
    Effect.gen(function* () {
      const text = "large report\n".repeat(6000)
      yield* database.db
        .update(WorkflowNodeTable)
        .set({ output: text })
        .where(eq(WorkflowNodeTable.workflow_id, "wf-1"))
        .run()
      expect(yield* deliver()).toBe(true)
      const receipt = (yield* database.db.select().from(PartTable))
        .map((row) => row.data as SessionV1.TextPart)
        .find((part) => part.metadata?.dag_delivery?.kind === "answer")!
      expect(receipt.text.length).toBeLessThan(2000)
      const artifact = receipt.metadata!.dag_delivery.artifact
      yield* verifyOutputFileRef(artifact)
      expect(yield* Effect.promise(() => readFile(artifact.path, "utf8"))).toBe(text)
    }),
  ))

it("uses the captured file receipt and refuses to acknowledge a missing managed object", () =>
  fixture(({ database, deliver }) =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "dag-delivery-file-")))
      yield* Effect.gen(function* () {
        const source = path.join(directory, "report.txt")
        yield* Effect.promise(() => writeFile(source, `file report ${directory}`))
        const artifact = (yield* commitOutputFileRef(source, {
          workflow_id: "wf-1",
          node_id: "final",
          child_session_id: "ses_child",
          replan_attempt: 0,
          graph_rev: 2,
        }))!
        yield* database.db
          .update(WorkflowNodeTable)
          .set({ output: artifact.path, captured_output: artifact, captured_output_present: true })
          .where(eq(WorkflowNodeTable.workflow_id, "wf-1"))
          .run()
        yield* deliver()
        const receipt = (yield* database.db.select().from(PartTable))
          .map((row) => row.data as SessionV1.TextPart)
          .find((part) => part.metadata?.dag_delivery?.kind === "answer")!
        expect(receipt.text).toContain("[Complete report]")
        expect(receipt.metadata?.dag_delivery.artifact.sha256).toBe(artifact.sha256)
        yield* Effect.promise(() => rm(artifact.path))
        yield* database.db.update(WorkflowTable).set({ wake_reported: false }).where(eq(WorkflowTable.id, "wf-1")).run()
        expect((yield* deliver().pipe(Effect.exit))._tag).toBe("Failure")
      }).pipe(Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))))
    }),
  ))

it("keeps the fallback synthetic anchor before its assistant using canonical ordering", () => fixture(({ database, deliver }) => Effect.gen(function* () {
  yield* deliver()
  const messages = yield* database.db.select().from(MessageTable)
  const user = messages.find((row) => row.data.role === "user")!
  const answer = messages.find((row) => row.data.role === "assistant")!
  expect(before({ id: user.id, time: user.data.time }, { id: answer.id, time: answer.data.time })).toBe(true)
  const zero = reportIdentity(makeWorkflowRow({ completedAt: 0, timeUpdated: 0 }))
  expect(before({ id: zero.anchorID, time: { created: 0 } }, { id: zero.messageID, time: { created: 0 } })).toBe(true)
})))

it("does not consume a same-millisecond user that sorts after the previous assistant", () => fixture(({ sessions, deliver }) => Effect.gen(function* () {
  yield* sessions.updateMessage({ id: "msg_z_pending" as never, sessionID: "ses_parent" as never, role: "user", time: { created: 50 }, agent: "build", model: { providerID: "test" as never, modelID: "test" as never } })
  yield* sessions.updateMessage({ id: "msg_a_previous" as never, sessionID: "ses_parent" as never, parentID: "msg_previous" as never, role: "assistant", time: { created: 50, completed: 50 }, agent: "build", mode: "build", path: { cwd: "/tmp", root: "/tmp" }, providerID: "test" as never, modelID: "test" as never, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" })
  expect(yield* deliver()).toBe(false)
})))
