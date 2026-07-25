import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { reconcileWorkflow } from "@/dag/runtime/recovery"
import { Dag } from "@/dag/dag"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowRuntime } from "@opencode-ai/core/dag/core/scheduling"
import { SUCCESS_TERMINAL, toSchedulingNodes } from "@/dag/runtime/loop"
import { makeNodeRow } from "./fixtures"

type TrackedEvent = {
  type: string
  nodeID: string
  output?: unknown
  reason?: string
  trigger?: string
}

function makeDagLayer(nodes: DagStore.NodeRow[], trackedEvents: TrackedEvent[], actions?: string[]) {
  return Layer.mock(Dag.Service, {
    store: {
      getNodes: () => Effect.succeed(nodes),
      getNode: (id: string) => Effect.succeed(nodes.find((n) => n.id === id)),
    } as unknown as DagStore.Interface,
    nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string, output: unknown) =>
      Effect.sync(() => trackedEvents.push({
        type: "nodeCompleted",
        nodeID,
        ...(output === undefined ? {} : { output }),
      })),
    ),
    nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string, trigger: string) =>
      Effect.sync(() => {
        actions?.push(`failed:${trigger}`)
        trackedEvents.push({ type: "nodeFailed", nodeID, reason, trigger })
      }),
    ),
    nodeStarted: Effect.fn("stub.nodeStarted")((dagID: string, nodeID: string) =>
      Effect.sync(() => trackedEvents.push({ type: "nodeStarted", nodeID })),
    ),
  })
}

describe("reconcileWorkflow", () => {
  it("publishes NodeCompleted for running node with completed child session", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("completed" as const)

    await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toContainEqual({ type: "nodeCompleted", nodeID: "n1" })
    expect(events).not.toContainEqual({ type: "nodeFailed", nodeID: "n1" })
  })

  it("publishes NodeFailed for running node with failed child session", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("failed" as const)

    await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toContainEqual(expect.objectContaining({ type: "nodeFailed", nodeID: "n1" }))
  })

  it("publishes NodeFailed for running node with no child session", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: null })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)

    await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toContainEqual(expect.objectContaining({ type: "nodeFailed", nodeID: "n1" }))
  })

  it("cancels and fails an active child with no deadline after execution ownership is lost", async () => {
    const events: TrackedEvent[] = []
    const cancelled: string[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)
    const cancelSession = (sessionID: string) => Effect.sync(() => cancelled.push(sessionID))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, cancelSession).pipe(Effect.provide(dagLayer)),
    )

    expect(cancelled).toEqual(["ses_1"])
    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: "execution ownership lost on recovery",
      trigger: "exec_failed",
    })
    expect(result).toEqual({ reconciled: 1, ownershipLost: 1 })
  })

  it("leaves pending node with no child session for spawnReady", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "pending", childSessionId: null })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)

    const result = await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toEqual([])
    expect(result.reconciled).toBe(0)
  })

  it("skips pending node with child session (restart-orphan, left for spawnReady)", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "pending", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)

    const result = await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    // Pending nodes with a childSessionId are restart-orphans (NodeRestarted
    // set them pending but replacement was never spawned). Recovery should NOT
    // re-attach to the old session — leave them pending for spawnReady.
    expect(events).not.toContainEqual({ type: "nodeStarted", nodeID: "n1" })
    expect(result.reconciled).toBe(0)
    expect(result.ownershipLost).toBe(0)
  })

  it("skips non-running, non-pending nodes", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [
      makeNodeRow({ id: "n1", status: "completed", childSessionId: "ses_1" }),
      makeNodeRow({ id: "n2", status: "skipped", childSessionId: null }),
    ]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("completed" as const)

    const result = await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toEqual([])
    expect(result.reconciled).toBe(0)
  })

  it("cancels and fails a zero-message child classified as unknown exactly once", async () => {
    const events: TrackedEvent[] = []
    const cancelled: string[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("unknown" as const)
    const cancelSession = (sessionID: string) => Effect.sync(() => cancelled.push(sessionID))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, cancelSession).pipe(Effect.provide(dagLayer)),
    )

    expect(cancelled).toEqual(["ses_1"])
    expect(events.filter((event) => event.type === "nodeFailed")).toEqual([
      {
        type: "nodeFailed",
        nodeID: "n1",
        reason: "execution ownership lost on recovery",
        trigger: "exec_failed",
      },
    ])
    expect(result).toEqual({ reconciled: 1, ownershipLost: 1 })
  })

  it("cancels before failing a running node whose deadline expired during crash", async () => {
    const events: TrackedEvent[] = []
    const actions: string[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", deadlineMs: Date.now() - 10000 })]
    const dagLayer = makeDagLayer(nodes, events, actions)
    const checkStatus = () => Effect.succeed("active" as const)
    const cancelSession = () => Effect.sync(() => actions.push("cancelled"))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, cancelSession).pipe(Effect.provide(dagLayer)),
    )

    expect(actions).toEqual(["cancelled", "failed:timeout"])
    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: "deadline exceeded on recovery",
      trigger: "timeout",
    })
    expect(result).toEqual({ reconciled: 1, ownershipLost: 1 })
  })

  it("cancels and fails an active child with a future deadline after execution ownership is lost", async () => {
    const events: TrackedEvent[] = []
    const cancelled: string[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", deadlineMs: Date.now() + 60000 })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)
    const cancelSession = (sessionID: string) => Effect.sync(() => cancelled.push(sessionID))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, cancelSession).pipe(Effect.provide(dagLayer)),
    )

    expect(cancelled).toEqual(["ses_1"])
    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: "execution ownership lost on recovery",
      trigger: "exec_failed",
    })
    expect(result).toEqual({ reconciled: 1, ownershipLost: 1 })
  })

  it("terminalizes the node even when cancelling the lost child session fails", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", deadlineMs: null })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("unknown" as const)
    const cancelSession = () => Effect.fail(new Error("cancel unavailable"))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, cancelSession).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: "execution ownership lost on recovery",
      trigger: "exec_failed",
    })
    expect(result).toEqual({ reconciled: 1, ownershipLost: 1 })
  })

  it("preserves captured structured output from an already completed child session", async () => {
    const events: TrackedEvent[] = []
    const output = { summary: "done" }
    const nodes = [
      makeNodeRow({
        id: "n1",
        status: "running",
        childSessionId: "ses_1",
        capturedOutput: output,
      }),
    ]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("completed" as const)
    const workflowConfig = {
      nodes: [{ id: "n1", output_schema: { type: "object" } }],
    }

    await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, undefined, workflowConfig).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toContainEqual({ type: "nodeCompleted", nodeID: "n1", output })
    expect(events.find((event) => event.type === "nodeFailed")).toBeUndefined()
  })

  it("fails an already completed child whose required structured output was never captured", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("completed" as const)
    const workflowConfig = {
      nodes: [{ id: "n1", output_schema: { type: "object" } }],
    }

    await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, undefined, workflowConfig).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: "output_schema declared but submit_result was never successfully called (recovered)",
      trigger: "verdict_fail",
    })
  })
})

describe("rehydration via toSchedulingNodes", () => {
  it("maps every durable node status into the scheduling state machine", () => {
    const nodes = [
      makeNodeRow({ id: "pending", status: "pending" }),
      makeNodeRow({ id: "queued", status: "queued" }),
      makeNodeRow({ id: "running", status: "running" }),
      makeNodeRow({ id: "paused", status: "paused" }),
      makeNodeRow({ id: "completed", status: "completed" }),
      makeNodeRow({ id: "failed", status: "failed" }),
      makeNodeRow({ id: "aborted", status: "aborted" }),
      makeNodeRow({ id: "skipped", status: "skipped" }),
    ]

    expect(toSchedulingNodes(nodes).map((node) => [node.id, node.status])).toEqual([
      ["pending", "pending"],
      ["queued", "pending"],
      ["running", "running"],
      ["paused", "pending"],
      ["completed", "satisfied"],
      ["failed", "unsatisfied"],
      ["aborted", "satisfied"],
      ["skipped", "satisfied"],
    ])
  })

  it("running nodes are seeded as running in WorkflowRuntime", () => {
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    expect(rt.getReadyNodes()).toEqual([])
    expect(rt.isComplete()).toBe(false)
  })

  it("completed nodes after reconciliation are seeded as satisfied", () => {
    const nodes = [
      makeNodeRow({ id: "n1", status: "completed" }),
      makeNodeRow({ id: "n2", status: "pending", dependsOn: ["n1"] }),
    ]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    expect(rt.getReadyNodes()).toEqual(["n2"])
  })

  it("failed nodes after reconciliation are seeded as unsatisfied with cascade", () => {
    const nodes = [
      makeNodeRow({ id: "n1", status: "failed", required: true }),
      makeNodeRow({ id: "n2", status: "pending", dependsOn: ["n1"] }),
    ]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    expect(rt.getReadyNodes()).toEqual([])
    expect(rt.isComplete()).toBe(true)
    expect(rt.hasRequiredFailure()).toBe(true)
  })

  it("failed optional nodes after reconciliation unblock dependents", () => {
    const nodes = [
      makeNodeRow({ id: "n1", status: "failed", required: false }),
      makeNodeRow({ id: "n2", status: "pending", dependsOn: ["n1"], required: true }),
    ]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    expect(rt.getReadyNodes()).toEqual(["n2"])
    expect(rt.hasRequiredFailure()).toBe(false)
  })

  it("paused workflow rehydrates with setPaused(true)", () => {
    const nodes = [makeNodeRow({ id: "n1", status: "pending" })]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    rt.setPaused(true)
    expect(rt.isPaused()).toBe(true)
    expect(rt.getReadyNodes()).toEqual([])
  })
})
