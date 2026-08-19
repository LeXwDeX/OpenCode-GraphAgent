// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Mirrors the
// dag-structured-output.test.ts harness idiom (and dag-location-guards.test.ts
// suppression precedent): mocked Agent/Session/prompt layers and the typed
// reply fixture use type-only shims for branded IDs — converting them would
// fork the shared harness shape without changing behavior.
import { describe, expect, it } from "bun:test"
import { Effect, Layer, Semaphore, Fiber } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionPrompt } from "@/session/prompt"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"
import type { DagStore } from "@opencode-ai/core/dag/store"

type TrackedEvent = { type: string; nodeID: string }

// #379 regression: control(pause) must hold a queued node's spawn fiber at the
// pause fence — no child session, no terminal event — and control(resume)
// (workflow status back to "running") must let the fiber proceed and complete.

function makeHarness(workflowStatus: () => string, claimAdoption: () => boolean) {
  const events: TrackedEvent[] = []
  let createCalls = 0
  const storeStub: Partial<DagStore.Interface> = {
    tryClaimAdoption: () => Effect.sync(() => claimAdoption()),
    getWorkflow: () => Effect.sync(() => makeWorkflowRow({ status: workflowStatus() })),
    getNode: Effect.fn("s")((_workflowID: string, nodeID: string) =>
      Effect.sync(() => makeNodeRow({ id: nodeID, status: "queued" }))),
  }
  const dagLayer = Layer.mock(Dag.Service, {
    store: storeStub as DagStore.Interface,
    nodeQueued: Effect.fn("s")(() => Effect.void),
    nodeStarted: Effect.fn("s")(() => Effect.void),
    nodeCompleted: Effect.fn("s")((_dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeCompleted", nodeID }))),
    nodeFailed: Effect.fn("s")((_dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeFailed", nodeID }))),
    nodeSkipped: Effect.fn("s")((_dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeSkipped", nodeID }))),
  })
  const agentLayer = Layer.mock(Agent.Service, {
    get: () => Effect.succeed({
      name: "build", mode: "all", permission: [], options: {}, description: "", prompt: "",
      model: { providerID: "test" as never, modelID: "test-model" as never },
      tools: {}, hooks: {},
    }),
    list: () => Effect.succeed([]),
    defaultAgent: () => Effect.succeed("build"),
  })
  const sessionLayer = Layer.mock(Session.Service, {
    get: () => Effect.succeed({ id: "ses_parent" as never, permission: [], agent: "build" } as never),
    create: () => Effect.sync(() => {
      createCalls++
      return { id: "ses_child" as never } as never
    }),
    list: () => Effect.succeed([]),
    messages: () => Effect.succeed([]),
  })
  const promptLayer = Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.succeed(reply()),
  })
  return { events, createCalls: () => createCalls, fullLayer: Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer) }
}

function reply(): SessionV1.WithParts {
  return {
    info: {
      id: "msg_reply", role: "assistant", parentID: "msg_parent", sessionID: "ses_child",
      mode: "build", agent: "build", cost: 0, path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model", providerID: "test",
      time: { created: 0 }, finish: "stop",
    },
    parts: [{ type: "text", text: "Task completed" }],
  } as SessionV1.WithParts
}

function makeSpawnInput(): NodeSpawnInput {
  return {
    dagID: "wf-1",
    nodeID: "node-1",
    node: makeNodeRow(),
    parentSessionID: "ses_parent",
    promptParts: [{ type: "text", text: "do the thing" }],
  }
}

describe("spawnNode pause fence (#379)", () => {
  it("holds a queued node at the fence while the workflow is paused, then spawns after resume", async () => {
    let paused = true
    const harness = makeHarness(() => (paused ? "paused" : "running"), () => true)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput())
          // Two+ poll cycles past the initial read: the fiber must still be
          // held — no child session, no terminal transition.
          yield* Effect.sleep(600)
          expect(harness.createCalls()).toBe(0)
          expect(harness.events).toHaveLength(0)
          paused = false
          yield* Fiber.await(result.fiber)
          expect(harness.createCalls()).toBe(1)
          expect(harness.events.find((e) => e.type === "nodeCompleted")).toBeDefined()
        }),
      ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
    )
  })

  it("exits without creating a session when the workflow terminalizes during the pause hold", async () => {
    let status = "paused"
    const harness = makeHarness(() => status, () => false)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput())
          yield* Effect.sleep(300)
          expect(harness.createCalls()).toBe(0)
          status = "cancelled"
          yield* Fiber.await(result.fiber)
          expect(harness.createCalls()).toBe(0)
          expect(harness.events).toHaveLength(0)
        }),
      ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
    )
  })
})
