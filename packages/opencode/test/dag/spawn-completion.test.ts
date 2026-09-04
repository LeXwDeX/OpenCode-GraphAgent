import { describe, expect, it } from "bun:test"
import { Effect, Layer, Semaphore, Fiber } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { TerminalViolationError } from "@opencode-ai/core/dag/core/types"
import { makeNodeRow } from "./fixtures"

type TrackedEvent = {
  type: string
  dagID: string
  nodeID: string
  output?: unknown
  reason?: string
  trigger?: string
}

function makeEventTracker() {
  const events: TrackedEvent[] = []
  const dagLayer = Layer.mock(Dag.Service, {
    store: { tryClaimAdoption: () => Effect.succeed(true) } as unknown as DagStore.Interface,
    nodeQueued: Effect.fn("stub.nodeQueued")((dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeQueued", dagID, nodeID })),
    ),
    nodeStarted: Effect.fn("stub.nodeStarted")((dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeStarted", dagID, nodeID })),
    ),
    nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string, output: unknown) =>
      Effect.sync(() => events.push({ type: "nodeCompleted", dagID, nodeID, output })),
    ),
    nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string, trigger: string) =>
      Effect.sync(() => events.push({ type: "nodeFailed", dagID, nodeID, reason, trigger })),
    ),
  })
  return { events, dagLayer }
}

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
  create: () => Effect.succeed({ id: "ses_child" as never } as never),
  list: () => Effect.succeed([]),
  messages: () => Effect.succeed([]),
})

function reply(text: string, includeText = text !== ""): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(), role: "assistant", parentID: MessageID.ascending(),
      sessionID: "ses_child" as never, mode: "build", agent: "build", cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never, providerID: "test" as never,
      time: { created: Date.now() }, finish: "stop",
    },
    parts: includeText ? [{ type: "text", text }] as never : [],
  }
}

function makePromptLayer(result: SessionV1.WithParts): Layer.Layer<never> {
  return Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.succeed(result),
  })
}

function makeFailingPromptLayer(error: string): Layer.Layer<never> {
  return Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.die(new Error(error)),
  })
}

function makeSpawnInput(): NodeSpawnInput {
  return {
    dagID: "wf-1",
    nodeID: "node-1",
    node: makeNodeRow(),
    parentSessionID: "ses_parent",
    promptParts: [{ type: "text", text: "do the thing" }] as never,
  }
}

async function runSpawn(dagLayer: Layer.Layer<never>, extraLayer: Layer.Layer<never>) {
  const semaphore = Semaphore.makeUnsafe(1)
  const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, extraLayer)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* spawnNode(semaphore, makeSpawnInput())
        yield* Fiber.await(result.fiber)
      }),
    ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
  )
}

function findEvent(events: TrackedEvent[], type: string) {
  return events.find((e) => e.type === type)
}

describe("spawnNode completion bridge", () => {
  it("inherits the parent session model when the node and agent omit one", async () => {
    const { events, dagLayer } = makeEventTracker()
    let promptModel: SessionPrompt.PromptInput["model"]
    const agentWithoutModel = Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "general",
          mode: "all",
          permission: [],
          options: {},
          description: "",
          prompt: "",
          tools: {},
          hooks: {},
        }),
    })
    const parentWithModel = Layer.mock(Session.Service, {
      get: () =>
        Effect.succeed({
          id: "ses_parent",
          permission: [],
          agent: "build",
          model: { providerID: "local-proxy-compatible", id: "glm-5.2" },
        } as never),
      create: () => Effect.succeed({ id: "ses_child" as never } as never),
    })
    const prompt = Layer.mock(SessionPrompt.Service, {
      prompt: (input) =>
        Effect.sync(() => {
          promptModel = input.model
          return reply("done")
        }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput())
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentWithoutModel, parentWithModel, prompt))) as Effect.Effect<never>,
    )

    expect(promptModel as unknown).toEqual({
      providerID: "local-proxy-compatible",
      modelID: "glm-5.2",
    })
    expect(findEvent(events, "nodeCompleted")).toBeDefined()
  })

  it("prefers the configured DAG tier over the worker agent model", async () => {
    const { events, dagLayer } = makeEventTracker()
    let promptModel: SessionPrompt.PromptInput["model"]
    const prompt = Layer.mock(SessionPrompt.Service, {
      prompt: (input) =>
        Effect.sync(() => {
          promptModel = input.model
          return reply("done")
        }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
            ...makeSpawnInput(),
            fallbackModel: {
              providerID: "configured",
              modelID: "dag-tier-model",
            },
          })
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessionLayer, prompt))) as Effect.Effect<never>,
    )

    expect(promptModel as unknown).toEqual({
      providerID: "configured",
      modelID: "dag-tier-model",
    })
    expect(findEvent(events, "nodeCompleted")).toBeDefined()
  })

  it("canonicalizes a provider-qualified model from a persisted node", async () => {
    const { events, dagLayer } = makeEventTracker()
    let promptModel: SessionPrompt.PromptInput["model"]
    const prompt = Layer.mock(SessionPrompt.Service, {
      prompt: (input) =>
        Effect.sync(() => {
          promptModel = input.model
          return reply("done")
        }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
            ...makeSpawnInput(),
            node: makeNodeRow({
              modelId: "local-proxy-compatible/glm-5.2",
              modelProviderId: "local-proxy-compatible",
            }),
          })
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessionLayer, prompt))) as Effect.Effect<never>,
    )

    expect(promptModel as unknown).toEqual({
      providerID: "local-proxy-compatible",
      modelID: "glm-5.2",
    })
    expect(findEvent(events, "nodeCompleted")).toBeDefined()
  })

  it("publishes NodeCompleted with output text on success", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("Task completed successfully")))

    const completed = findEvent(events, "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toBe("Task completed successfully")

    const started = findEvent(events, "nodeStarted")
    expect(started).toBeDefined()
  })

  it("publishes verdict_fail when the provider returns no text output", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("")))

    expect(findEvent(events, "nodeCompleted")).toBeUndefined()
    expect(findEvent(events, "nodeFailed")).toEqual(expect.objectContaining({
      reason: "provider returned empty output",
      trigger: "verdict_fail",
    }))
  })

  it("classifies empty and whitespace-only text parts like missing text", async () => {
    for (const text of ["", " \n\t "]) {
      const { events, dagLayer } = makeEventTracker()
      await runSpawn(dagLayer, makePromptLayer(reply(text, true)))
      expect(findEvent(events, "nodeCompleted")).toBeUndefined()
      expect(findEvent(events, "nodeFailed")).toEqual(expect.objectContaining({
        reason: "provider returned empty output",
        trigger: "verdict_fail",
      }))
    }
  })

  it("preserves non-empty text byte-for-byte", async () => {
    const { events, dagLayer } = makeEventTracker()
    const text = "\n  exact output\t"
    await runSpawn(dagLayer, makePromptLayer(reply(text, true)))

    expect(findEvent(events, "nodeCompleted")?.output).toBe(text)
  })

  it("publishes NodeFailed when prompt fails", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makeFailingPromptLayer("LLM exploded"))

    const failed = findEvent(events, "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.reason).toContain("Error: LLM exploded")
    expect(failed!.reason).not.toContain("Cause([Die(")

    expect(findEvent(events, "nodeCompleted")).toBeUndefined()
  })

  it("publishes exactly one terminal event per node", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("done")))

    const terminal = events.filter((e) => e.type === "nodeCompleted" || e.type === "nodeFailed")
    expect(terminal.length).toBe(1)
  })

  it("releases its permit for the next node", async () => {
    const { events, dagLayer } = makeEventTracker()
    const semaphore = Semaphore.makeUnsafe(1)
    const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, makePromptLayer(reply("done")))

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* spawnNode(semaphore, makeSpawnInput())
          yield* Fiber.await(first.fiber)
          const second = yield* spawnNode(semaphore, makeSpawnInput())
          yield* Fiber.await(second.fiber)
        }),
      ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
    )

    expect(events.filter((event) => event.type === "nodeCompleted")).toHaveLength(2)
  })
})

describe("spawnNode terminalization during spawn window", () => {
  it("does NOT publish spurious NodeFailed when node was cancelled mid-spawn", async () => {
    const events: TrackedEvent[] = []
    let cancelCalled = false
    const dagLayer = Layer.mock(Dag.Service, {
      store: { tryClaimAdoption: () => Effect.succeed(true) } as unknown as DagStore.Interface,
      nodeQueued: () => Effect.void,
      nodeStarted: () => Effect.fail(new TerminalViolationError("node-1", "failed", "running")),
      nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string) =>
        Effect.sync(() => events.push({ type: "nodeCompleted", dagID, nodeID })),
      ),
      nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string) =>
        Effect.sync(() => events.push({ type: "nodeFailed", dagID, nodeID, reason })),
      ),
    })
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      prompt: () => Effect.die(new Error("prompt should NOT be called after terminalization")),
      cancel: () => Effect.sync(() => { cancelCalled = true }),
    })

    const semaphore = Semaphore.makeUnsafe(1)
    const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(semaphore, makeSpawnInput())
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
    )

    expect(events.filter((e) => e.type === "nodeFailed")).toEqual([])
    expect(events.filter((e) => e.type === "nodeCompleted")).toEqual([])
    expect(cancelCalled).toBe(true)
  })

  it("cancels the child session when nodeStarted fails after session creation", async () => {
    const events: TrackedEvent[] = []
    let cancelCalled = false
    let promptCalled = false
    const dagLayer = Layer.mock(Dag.Service, {
      store: { tryClaimAdoption: () => Effect.succeed(true) } as unknown as DagStore.Interface,
      nodeQueued: () => Effect.void,
      nodeStarted: () => Effect.fail(new Error("nodeStarted write failed")),
      nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string) =>
        Effect.sync(() => events.push({ type: "nodeCompleted", dagID, nodeID })),
      ),
      nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string) =>
        Effect.sync(() => events.push({ type: "nodeFailed", dagID, nodeID, reason })),
      ),
    })
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      prompt: () =>
        Effect.sync(() => {
          promptCalled = true
          return reply("unexpected")
        }),
      cancel: () => Effect.sync(() => { cancelCalled = true }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput())
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer))) as Effect.Effect<never>,
    )

    expect(promptCalled).toBe(false)
    expect(findEvent(events, "nodeFailed")?.reason).toContain("nodeStarted write failed")
    expect(cancelCalled).toBe(true)
  })
})
