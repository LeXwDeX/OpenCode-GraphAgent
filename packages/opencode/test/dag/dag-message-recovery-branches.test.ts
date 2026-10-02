import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Dag, StaleMessageInputError } from "@/dag/dag"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { DagStore } from "@opencode-ai/core/dag/store"
import { continueRecoveredMessageNode } from "@/dag/runtime/recovery"
import { hasCaptureSlot } from "@/dag/runtime/capture"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

type Config = Parameters<typeof continueRecoveredMessageNode>[2]
function reply(id: string, text = "updated result"): SessionV1.WithParts {
  const messageID = MessageID.make(id)
  const sessionID = SessionID.make("ses_recovery")
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID: MessageID.make("msg_initial"),
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.make(`prt_${id}`), sessionID, messageID, type: "text", text }],
  }
}
function harness(
  input: {
    node?: Partial<DagStore.NodeRow>
    workflow?: Partial<DagStore.WorkflowRow>
    noNode?: boolean
    noWorkflow?: boolean
    noMessages?: boolean
    queued?: number
    latestStop?: string
    settleStop?: string
    stale?: number
    text?: string
    userResult?: boolean
    modelError?: boolean
    guardStale?: boolean
    afterStale?: (h: ReturnType<typeof state>) => void
    afterLoop?: (h: ReturnType<typeof state>) => void
  } = {},
) {
  const h = state(input)
  const snapshot: DagMessages.Snapshot = {
    id: "ags_current",
    mailboxID: "box",
    logicalTurnID: "msg_result",
    revision: 1,
    messages: [],
    associated: true,
  }
  const store = Layer.mock(DagStore.Service, {
    getNode: () => Effect.sync(() => h.node),
    getWorkflow: () => Effect.sync(() => h.workflow),
    getNodes: () => Effect.sync(() => (h.node ? [h.node] : [])),
    setCapturedOutput: (_session, output) =>
      Effect.sync(() => {
        h.receipts.push(output)
      }),
  })
  const dag = Layer.unwrap(
    Effect.map(DagStore.Service, (store) =>
      Layer.mock(Dag.Service, {
        store,
        nodeCompleted: (_dag, _node, output, attempt) =>
          Effect.gen(function* () {
            h.completionAttempts++
            if (h.stale-- > 0) {
              input.afterStale?.(h)
              yield* new StaleMessageInputError({ dagID: "dag_recovery", nodeID: "n", reason: "stale_input" })
            }
            h.completed.push({ output, attempt })
          }),
        nodeFailed: (_dag, _node, reason, errorClass) =>
          Effect.sync(() => {
            h.failed.push({ reason, errorClass })
          }),
      }),
    ),
  ).pipe(Layer.provide(store))
  let rejectedReceipt = input.guardStale === true
  const messages = Layer.mock(DagMessages.Service, {
    revisions: () =>
      Effect.succeed({
        ok: true,
        value: {
          endpoint: { id: "box", kind: "node", sessionID: "ses_recovery" },
          accepted: 1,
          snapshot: 1,
          snapshotID: input.latestStop ? snapshot.id : undefined,
          queued: input.queued ?? 0,
          delivered: 1,
          undeliverable: 0,
        },
      }),
    guard: (_caller, _input, commit) => {
      h.guardCalls++
      if (rejectedReceipt) {
        rejectedReceipt = false
        return Effect.succeed({ ok: false as const, reason: "stale_input" as const })
      }
      return commit.pipe(Effect.map((value) => ({ ok: true as const, value })))
    },
    snapshotByID: () => Effect.succeed({ ok: true, value: { ...snapshot, stopReason: input.latestStop } }),
    latestSnapshot: () =>
      Effect.succeed({ ok: true, value: input.latestStop ? { ...snapshot, stopReason: input.latestStop } : undefined }),
    claimResultNudge: (_caller, revision) =>
      Effect.sync(() => {
        const claimed = !h.claimedNudgeRevisions.includes(revision)
        if (claimed) h.claimedNudgeRevisions.push(revision)
        return { ok: true as const, value: claimed }
      }),
    snapshotForTurn: () => Effect.succeed({ ok: true, value: { ...snapshot, stopReason: input.settleStop } }),
  })
  const prompt = Layer.mock(SessionPrompt.Service, {
    loop: () =>
      Effect.sync(() => {
        h.loops++
        input.afterLoop?.(h)
        const r = reply(`msg_result_${h.loops}`, input.text)
        if (input.userResult)
          return {
            info: {
              id: MessageID.make("msg_user"),
              sessionID: SessionID.make("ses_recovery"),
              role: "user",
              time: { created: 1 },
              agent: "build",
              model: { modelID: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
            },
            parts: [],
          } satisfies SessionV1.WithParts
        if (input.modelError && r.info.role === "assistant")
          r.info.error = { name: "UnknownError", data: { message: "model failed" } }
        return r
      }),
    prompt: () =>
      Effect.sync(() => {
        h.prompts++
        if (h.node) {
          h.node.capturedOutput = null
          h.node.capturedOutputPresent = true
          h.node.capturedSnapshotID = "ags_new"
        }
        return reply("msg_nudged")
      }),
  })
  return {
    h,
    run: (config?: Config, directory?: string, authorizeSource?: Parameters<typeof continueRecoveredMessageNode>[4]) =>
      Effect.runPromise(
        continueRecoveredMessageNode("dag_recovery", "n", config, directory, authorizeSource).pipe(
          Effect.provide(Layer.mergeAll(dag, prompt, ...(input.noMessages ? [] : [messages]))),
          Effect.scoped,
        ),
      ),
  }
}
function state(input: {
  node?: Partial<DagStore.NodeRow>
  workflow?: Partial<DagStore.WorkflowRow>
  noNode?: boolean
  noWorkflow?: boolean
  stale?: number
}) {
  return {
    node: input.noNode
      ? undefined
      : ({
          id: "n",
          workflowId: "dag_recovery",
          childSessionId: "ses_recovery",
          status: "running",
          replanAttempts: 0,
          deadlineMs: null,
          capturedOutput: null,
          capturedOutputPresent: false,
          capturedSnapshotID: null,
          workerType: "build",
          name: "Node",
          required: true,
          dependsOn: [],
          modelId: null,
          modelProviderId: null,
          output: null,
          errorReason: null,
          errorClass: null,
          wakeEligible: true,
          wakeReported: false,
          timeoutExtensions: 0,
          escalationPending: false,
          superseded: false,
          seq: 1,
          startedAt: 1,
          completedAt: null,
          ...input.node,
        } satisfies DagStore.NodeRow),
    workflow: input.noWorkflow
      ? undefined
      : ({
          id: "dag_recovery",
          projectId: "p",
          directory: process.cwd(),
          status: "running",
          sessionId: "ses_parent",
          title: "Recovery",
          config: "{}",
          seq: 1,
          wakeReported: false,
          graphRev: 0,
          startedAt: 1,
          completedAt: null,
          timeCreated: 1,
          timeUpdated: 1,
          ...input.workflow,
        } satisfies DagStore.WorkflowRow),
    loops: 0,
    prompts: 0,
    completionAttempts: 0,
    guardCalls: 0,
    receipts: [] as unknown[],
    claimedNudgeRevisions: [] as number[],
    stale: input.stale ?? 0,
    completed: [] as { output: unknown; attempt: unknown }[],
    failed: [] as { reason: string; errorClass: unknown }[],
  }
}
const structured: Config = { nodes: [{ id: "n", output_schema: { type: ["string", "null"] } }] }

describe("message recovery continuation admission and settlement branches", () => {
  for (const [name, input] of [
    ["absent mailbox service", { noMessages: true }],
    ["missing node", { noNode: true }],
    ["node without child", { node: { childSessionId: null } }],
    ["terminal node", { node: { status: "completed" } }],
    ["missing workflow", { noWorkflow: true }],
    ["workflow without directory", { workflow: { directory: null } }],
    ["paused workflow", { workflow: { status: "paused" } }],
    ["cancelled workflow", { workflow: { status: "cancelled" } }],
  ] as const)
    test(`does not call the model for ${name}`, async () => {
      const { h, run } = harness(input)
      await run()
      expect(h.loops).toBe(0)
      expect(h.completed).toEqual([])
      expect(h.failed).toEqual([])
    })
  test("stopped durable budget cannot reset its continuation allowance", async () => {
    const { h, run } = harness({ latestStop: "budget_exhausted" })
    await run()
    expect(h.loops).toBe(0)
    expect(h.failed[0].reason).toContain("budget_exhausted")
  })
  test("expired deadline fails without consuming a model round", async () => {
    const { h, run } = harness({ node: { deadlineMs: Date.now() - 1000 } })
    await run()
    expect(h.loops).toBe(0)
    expect(h.failed[0].errorClass).toBe("timeout")
  })
  for (const [name, input] of [
    ["model error", { modelError: true }],
    ["non assistant result", { userResult: true }],
    ["empty final output", { text: "  " }],
  ] as const)
    test(`permanently fails ${name}`, async () => {
      const { h, run } = harness(input)
      await run()
      expect(h.loops).toBe(1)
      expect(h.failed).toHaveLength(1)
      expect(h.completed).toEqual([])
    })
  for (const [name, mutation] of [
    [
      "node disappeared",
      (h: ReturnType<typeof state>) => {
        h.node = undefined
      },
    ],
    [
      "node ended",
      (h: ReturnType<typeof state>) => {
        if (h.node) h.node.status = "failed"
      },
    ],
    [
      "new child attempt",
      (h: ReturnType<typeof state>) => {
        if (h.node) h.node.childSessionId = "ses_new"
      },
    ],
    [
      "new attempt generation",
      (h: ReturnType<typeof state>) => {
        if (h.node) h.node.replanAttempts++
      },
    ],
    [
      "workflow disappeared",
      (h: ReturnType<typeof state>) => {
        h.workflow = undefined
      },
    ],
    [
      "workflow cancelled",
      (h: ReturnType<typeof state>) => {
        if (h.workflow) h.workflow.status = "cancelled"
      },
    ],
  ] as const)
    test(`does not settle after ${name} during the round`, async () => {
      const { h, run } = harness({ afterLoop: mutation })
      await run()
      expect(h.loops).toBe(1)
      expect(h.completed).toEqual([])
      expect(h.failed).toEqual([])
    })
  test("submitted structured null settles against its recorded snapshot and clears capture slot", async () => {
    const { h, run } = harness({
      node: { capturedOutput: null, capturedOutputPresent: true, capturedSnapshotID: "ags_null" },
    })
    await run(structured)
    expect(h.completed).toEqual([
      { output: null, attempt: { childSessionID: "ses_recovery", replanAttempts: 0, inputSnapshotID: "ags_null" } },
    ])
    expect(hasCaptureSlot("ses_recovery")).toBe(false)
  })
  test("missing structured submission fails instead of interpreting null as a value", async () => {
    const { h, run } = harness()
    await run(structured)
    expect(h.failed[0].errorClass).toBe("verdict_fail")
    expect(h.completed).toEqual([])
    expect(hasCaptureSlot("ses_recovery")).toBe(false)
  })
  test("stale structured capture without queued input gets one bounded result nudge", async () => {
    const { h, run } = harness({
      stale: 1,
      node: { capturedOutput: "old", capturedOutputPresent: true, capturedSnapshotID: "ags_old" },
    })
    await run(structured)
    expect(h.loops).toBe(1)
    expect(h.prompts).toBe(1)
    expect(h.claimedNudgeRevisions).toEqual([1])
    expect(h.completed[0].output).toBeNull()
    expect(h.completionAttempts).toBe(2)
  })
  test("a repeatedly stale structured result cannot claim a second nudge for unchanged input", async () => {
    const { h, run } = harness({
      stale: 2,
      node: { capturedOutput: "old", capturedOutputPresent: true, capturedSnapshotID: "ags_old" },
    })
    await run(structured)
    expect(h.loops).toBe(1)
    expect(h.prompts).toBe(1)
    expect(h.claimedNudgeRevisions).toEqual([1])
    expect(h.completionAttempts).toBe(2)
    expect(h.completed).toEqual([])
    expect(h.failed[0].reason).toContain("resubmission already requested")
  })
  test("stale output with queued input resumes its existing child instead of issuing a new prompt", async () => {
    const { h, run } = harness({ stale: 1, queued: 1 })
    await run()
    expect(h.loops).toBe(2)
    expect(h.prompts).toBe(0)
    expect(h.completed).toHaveLength(1)
  })
  test("a blocked stale snapshot cannot trigger another model round", async () => {
    const { h, run } = harness({ stale: 1, settleStop: "turn_blocked" })
    await run()
    expect(h.loops).toBe(1)
    expect(h.failed[0].reason).toContain("turn_blocked")
    expect(h.prompts).toBe(0)
  })
  for (const next of ["running", "cancelled"] as const)
    test(`holds an in-flight result during pause until ${next}`, async () => {
      const { h, run } = harness({
        afterLoop: (h) => {
          if (!h.workflow) throw new Error("Expected workflow")
          h.workflow.status = "paused"
          setTimeout(() => {
            if (h.workflow) h.workflow.status = next
          }, 25)
        },
      })
      await run()
      expect(h.loops).toBe(1)
      expect(h.prompts).toBe(0)
      expect(h.completed).toHaveLength(next === "running" ? 1 : 0)
    })
  test("deadline expiration during the model round rejects its late result", async () => {
    const { h, run } = harness({
      afterLoop: (h) => {
        if (h.node) h.node.deadlineMs = Date.now() - 1
      },
    })
    await run()
    expect(h.loops).toBe(1)
    expect(h.failed[0].errorClass).toBe("timeout")
    expect(h.completed).toEqual([])
  })
  test("deadline expiration after stale settlement prevents a new model admission", async () => {
    const { h, run } = harness({
      stale: 1,
      afterStale: (h) => {
        if (h.node) h.node.deadlineMs = Date.now() - 1
      },
    })
    await run()
    expect(h.loops).toBe(1)
    expect(h.failed[0].errorClass).toBe("timeout")
    expect(h.completed).toEqual([])
  })
  test("recovered review cannot bypass an unresolved implementation fingerprint", async () => {
    const { h, run } = harness({ node: { capturedOutputPresent: true, capturedOutput: {} } })
    await run({
      nodes: [
        {
          id: "n",
          output_schema: { type: "object" },
          review: { phase: "diff", implementation_node_id: "missing", verification_node_id: "verification" },
        },
      ],
    })
    expect(h.failed[0].reason).toContain("fingerprint")
    expect(h.completed).toEqual([])
  })
  for (const staleReceipt of [false, true])
    test(`persists a managed recovery receipt atomically before completion${staleReceipt ? " after rejecting a stale first receipt" : ""}`, async () => {
      await using dir = await tmpdir()
      const reports = path.join(dir.path, ".opencode", "workflow-reports")
      const filename = path.join(reports, "result.txt")
      await Bun.write(filename, "immutable recovery evidence")
      const { h, run } = harness({ text: filename, guardStale: staleReceipt, queued: staleReceipt ? 1 : 0 })
      const authorized: string[] = []
      await run(undefined, dir.path, (_child, source) =>
        Effect.sync(() => {
          authorized.push(source)
        }),
      )
      expect(h.receipts).toHaveLength(1)
      expect(h.receipts[0]).toMatchObject({ storage: "managed-v1", source_path: filename })
      expect(h.guardCalls).toBe(staleReceipt ? 2 : 1)
      expect(h.loops).toBe(staleReceipt ? 2 : 1)
      expect(h.completed).toHaveLength(1)
      expect(authorized).toEqual(staleReceipt ? [filename, filename] : [filename])
      expect(await Bun.file(path.join(dir.path, ".gitignore")).text()).toContain(".opencode/workflow-reports/")
    })
})
