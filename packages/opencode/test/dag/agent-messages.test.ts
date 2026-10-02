import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagAgentMessages } from "@/dag/agent-messages"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "../lib/effect"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"

const it = testEffect(Layer.empty)
const endpoint: DagMessages.Endpoint = {
  id: "endpoint-parent",
  kind: "main",
  sessionID: "ses_parent",
}
function transcript(): SessionV1.WithParts {
  const sessionID = SessionID.make("ses_child")
  const messageID = MessageID.make("msg_child")
  const part = { sessionID, messageID }
  return {
    info: {
      id: messageID,
      sessionID,
      parentID: MessageID.make("msg_parent"),
      role: "assistant",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: 1 },
    },
    parts: [
      { ...part, id: PartID.make("prt_reasoning"), type: "reasoning", text: "HIDDEN_REASONING", time: { start: 1 } },
      { ...part, id: PartID.make("prt_text"), type: "text", text: "Visible progress" },
      {
        ...part,
        id: PartID.make("prt_tool"),
        type: "tool",
        tool: "read",
        callID: "call_read",
        state: {
          status: "completed",
          input: { secret: "SECRET_TOOL_ARGUMENT" },
          title: "Read secret",
          output: "SECRET_TOOL_OUTPUT",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  }
}
function adapter(
  core: Partial<DagMessages.Interface>,
  store: Partial<DagStore.Interface> = {},
  sessions: Partial<Session.Interface> = {},
) {
  return DagAgentMessages.layer.pipe(
    Layer.provide(Layer.mock(DagMessages.Service, core)),
    Layer.provide(Layer.mock(DagStore.Service, store)),
    Layer.provide(Layer.mock(Session.Service, sessions)),
  )
}

describe("DAG agent message adapter", () => {
  it.instance("does not read a replacement child's transcript after observation authority changes", () => {
    let nodeReads = 0
    const transcriptReads: string[] = []
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const result = yield* messages.observe({ sessionID: "ses_child", workflow_id: "wf-1", node_id: "a" })
      expect(result).toEqual({ ok: false, reason: "unauthorized" })
      expect(transcriptReads).toEqual([])
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: () => Effect.succeed({ ok: false, reason: "unauthorized" }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () =>
              Effect.sync(() => [
                makeNodeRow({
                  id: "a",
                  childSessionId: nodeReads++ === 0 ? "ses_child" : "ses_replacement",
                  replanAttempts: nodeReads - 1,
                }),
              ]),
          },
          {
            messages: (input) =>
              Effect.sync(() => {
                transcriptReads.push(input.sessionID)
                return [transcript()]
              }),
          },
        ),
      ),
    )
  })

  it.instance("uses current project and directory authority and does not read a denied workflow", () => {
    let identity: DagMessages.Caller | undefined
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const instance = yield* InstanceState.context
      const observed = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf_foreign" })
      expect(identity).toEqual({
        sessionID: "ses_parent",
        projectID: instance.project.id,
        directory: instance.directory,
      })
      expect(observed).toEqual({ ok: false, reason: "unauthorized" })
    }).pipe(
      Effect.provide(
        adapter({
          resolve: (caller) =>
            Effect.sync(() => {
              identity = caller
              return { ok: false, reason: "unauthorized" }
            }),
        }),
      ),
    )
  })

  it.instance("observes paginated current and historical attempts without reading hidden reasoning", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      const observed = yield* messages.observe({ sessionID: "ses_parent", workflow_id: "wf-1", limit: 1 })
      expect(observed).toMatchObject({
        ok: true,
        graph_rev: 1,
        projection_sequence: 1,
        freshness: "durable_reads_nonatomic",
        nodes: [
          {
            node_id: "a",
            status: "running",
            attempt_id: DagMessages.nodeAttemptID("ses_child", 0),
            message_counts: { queued: 1, delivered: 2, undeliverable: 0 },
            progress: { text: "Visible progress", truncated: false },
            tools: [{ tool: "read", status: "completed" }],
          },
        ],
      })
      expect(JSON.stringify(observed)).not.toContain("HIDDEN_REASONING")
      expect(JSON.stringify(observed)).not.toContain("SECRET_TOOL_ARGUMENT")
      expect(JSON.stringify(observed)).not.toContain("SECRET_TOOL_OUTPUT")
      const historical = yield* messages.observe({
        sessionID: "ses_parent",
        workflow_id: "wf-1",
        node_id: "a",
        attempt_id: "attempt-old",
      })
      expect(historical).toMatchObject({
        nodes: [
          {
            node_id: "a",
            status: "attempt_replaced",
            historical: true,
            attempt_id: "attempt-old",
            closed_reason: "attempt_replaced",
          },
        ],
      })
      expect(JSON.stringify(historical)).not.toContain("CURRENT_OUTPUT")
    }).pipe(
      Effect.provide(
        adapter(
          {
            resolve: () => Effect.succeed({ ok: true, value: endpoint }),
            metadata: (_caller, workflowID, nodeID, attemptID) =>
              Effect.succeed({
                ok: true,
                value: {
                  endpoint: {
                    id: "endpoint-child",
                    kind: "node",
                    sessionID: "ses_child",
                    workflowID,
                    nodeID,
                    attemptID: attemptID ?? DagMessages.nodeAttemptID("ses_child", 0),
                  },
                  accepted: 3,
                  snapshot: 2,
                  queued: 1,
                  delivered: 2,
                  undeliverable: 0,
                  closedReason: attemptID === "attempt-old" ? "attempt_replaced" : undefined,
                },
              }),
          },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () =>
              Effect.succeed([
                makeNodeRow({ id: "a", status: "running", childSessionId: "ses_child", output: "CURRENT_OUTPUT" }),
                makeNodeRow({ id: "b" }),
              ]),
          },
          {
            messages: () => Effect.succeed([transcript()]),
          },
        ),
      ),
    ),
  )

  it.instance("does not let a child inspect a sibling through an owned workflow", () =>
    Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      expect(yield* messages.observe({ sessionID: "ses_child", workflow_id: "wf-1", node_id: "sibling" })).toEqual({
        ok: false,
        reason: "unauthorized",
      })
    }).pipe(
      Effect.provide(
        adapter(
          { resolve: () => Effect.succeed({ ok: true, value: endpoint }) },
          {
            getWorkflow: () => Effect.succeed(makeWorkflowRow()),
            getNodes: () => Effect.succeed([makeNodeRow({ id: "a", childSessionId: "ses_child" })]),
          },
        ),
      ),
    ),
  )

  it.instance("returns an immediate empty receive and passes workflow filtering to persistence", () => {
    let reads = 0
    return Effect.gen(function* () {
      const messages = yield* DagAgentMessages.Service
      expect(yield* messages.receive({ sessionID: "ses_parent", workflow_id: "wf-1", after_sequence: 7 })).toEqual({
        ok: true,
        messages: [],
        cursor: 7,
      })
      expect(reads).toBe(1)
    }).pipe(
      Effect.provide(
        adapter({
          resolve: () => Effect.succeed({ ok: true, value: endpoint }),
          receive: (_caller, input) =>
            Effect.sync(() => {
              reads += 1
              expect(input?.workflowID).toBe("wf-1")
              expect(input?.afterSequence).toBe(7)
              return { ok: true, value: [] }
            }),
        }),
      ),
    )
  })

  it.instance("cancels only the receive waiter without calling delivery or workflow mutation", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const abort = new AbortController()
      const layer = adapter({
        receive: () => Deferred.succeed(started, undefined).pipe(Effect.as({ ok: true, value: [] } as const)),
      })
      yield* Effect.gen(function* () {
        const messages = yield* DagAgentMessages.Service
        const waiter = yield* messages
          .receive({ sessionID: "ses_parent", wait_ms: 30_000, signal: abort.signal })
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        abort.abort()
        const outcome = yield* Fiber.await(waiter)
        expect(Exit.isFailure(outcome)).toBe(true)
        if (Exit.isFailure(outcome)) expect(Cause.hasInterrupts(outcome.cause)).toBe(true)
      }).pipe(Effect.provide(layer))
    }),
  )
})
