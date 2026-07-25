import { describe, expect, it } from "bun:test"
import { Effect, Layer, Semaphore, Fiber } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { evaluateCondition, resolveInputMapping } from "@/dag/runtime/eval"
import { registerCaptureSlot, validatePayload, clearCaptureSlot, validateAgainstSchema } from "@/dag/runtime/capture"
import { makeNodeRow } from "./fixtures"
import type { DagStore } from "@opencode-ai/core/dag/store"

type TrackedEvent = { type: string; nodeID: string; output?: unknown; reason?: string; trigger?: string }

let capturedStore: Map<string, unknown> = new Map()

function makeEventTracker() {
  const events: TrackedEvent[] = []
  capturedStore = new Map()
  const storeStub: Partial<DagStore.Interface> = {
    getNode: Effect.fn("s")((_workflowID: string, nodeID: string) =>
      Effect.sync(() => ({ ...makeNodeRow({ id: nodeID }), capturedOutput: capturedStore.get(nodeID) }))),
    setCapturedOutput: Effect.fn("s")((_childSessionID: string, payload: unknown) =>
      Effect.sync(() => { capturedStore.set("node-1", payload) })),
  }
  const dagLayer = Layer.mock(Dag.Service, {
    store: storeStub as DagStore.Interface,
    nodeStarted: Effect.fn("s")((_dagID: string, _nodeID: string) => Effect.void),
    nodeCompleted: Effect.fn("s")((_dagID: string, nodeID: string, output: unknown) =>
      Effect.sync(() => events.push({ type: "nodeCompleted", nodeID, output }))),
    nodeFailed: Effect.fn("s")((_dagID: string, nodeID: string, reason: string, trigger?: string) =>
      Effect.sync(() => events.push({ type: "nodeFailed", nodeID, reason, trigger }))),
    nodeSkipped: Effect.fn("s")((_dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeSkipped", nodeID }))),
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

function reply(text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(), role: "assistant", parentID: MessageID.ascending(),
      sessionID: "ses_child" as never, mode: "build", agent: "build", cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never, providerID: "test" as never,
      time: { created: Date.now() }, finish: "stop",
    },
    parts: text ? [{ type: "text", text }] as never : [],
  }
}

function makePromptLayer(result: SessionV1.WithParts): Layer.Layer<never> {
  return Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.succeed(result),
  })
}

function makePromptLayerWithCapture(result: SessionV1.WithParts, payloads: unknown[], schema: Record<string, unknown>): Layer.Layer<never> {
  return Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.gen(function* () {
      registerCaptureSlot("ses_child", schema)
      for (const payload of payloads) {
        const r = validatePayload("ses_child", payload)
        if (r.ok) capturedStore.set("node-1", payload)
      }
      return result
    }),
  })
}

function makeSpawnInput(
  outputSchema?: Record<string, unknown>,
  overrides: Partial<NodeSpawnInput> = {},
): NodeSpawnInput {
  return {
    dagID: "wf-1", nodeID: "node-1", node: makeNodeRow(),
    parentSessionID: "ses_parent",
    promptParts: [{ type: "text", text: "do the thing" }],
    outputSchema,
    ...overrides,
  }
}

async function runSpawn(
  dagLayer: Layer.Layer<never>,
  promptLayer: Layer.Layer<never>,
  outputSchema?: Record<string, unknown>,
  overrides: Partial<NodeSpawnInput> = {},
) {
  const semaphore = Semaphore.makeUnsafe(1)
  const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* spawnNode(semaphore, makeSpawnInput(outputSchema, overrides))
        yield* Fiber.await(result.fiber)
      }),
    ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
  )
}

// --- Unit tests for eval.ts ---

describe("evaluateCondition", () => {
  it("returns ok:true value:true for empty/undefined condition", () => {
    expect(evaluateCondition(undefined, {})).toEqual({ ok: true, value: true })
    expect(evaluateCondition("", {})).toEqual({ ok: true, value: true })
  })

  it("evaluates numeric comparison with structured output", () => {
    const outputs = { "explore": { output: { findings_count: 5 } } }
    expect(evaluateCondition("explore.output.findings_count > 0", outputs)).toEqual({ ok: true, value: true })
    expect(evaluateCondition("explore.output.findings_count > 10", outputs)).toEqual({ ok: true, value: false })
  })

  it("evaluates equality with structured output", () => {
    const outputs = { "check": { output: { status: "ok" } } }
    expect(evaluateCondition('check.output.status == "ok"', outputs)).toEqual({ ok: true, value: true })
    expect(evaluateCondition('check.output.status == "fail"', outputs)).toEqual({ ok: true, value: false })
  })

  it("returns ok:true value:false when path is missing (comparison with undefined)", () => {
    expect(evaluateCondition("missing.output.field > 0", {})).toEqual({ ok: true, value: false })
  })
})

describe("resolveInputMapping", () => {
  it("resolves full output reference", () => {
    const getOutput = (id: string) => (id === "refactor" ? { diff: "abc" } : undefined)
    const result = resolveInputMapping({ diff: "refactor.output" }, getOutput)
    expect(result).toEqual({ diff: { diff: "abc" } })
  })

  it("resolves nested field from output", () => {
    const getOutput = (id: string) => (id === "plan" ? { steps: ["a", "b"] } : undefined)
    const result = resolveInputMapping({ steps: "plan.output.steps" }, getOutput)
    expect(result).toEqual({ steps: ["a", "b"] })
  })

  it("returns empty for undefined mapping", () => {
    expect(resolveInputMapping(undefined, () => null)).toEqual({})
  })

  it("resolves to null for missing node", () => {
    const result = resolveInputMapping({ x: "ghost.output" }, () => null)
    expect(result).toEqual({ x: null })
  })
})

// --- Unit tests for capture.ts (submit_result validation) ---

describe("validateAgainstSchema", () => {
  it("accepts matching object type", () => {
    expect(validateAgainstSchema({ a: 1 }, { type: "object" })).toEqual({ ok: true })
  })

  it("rejects wrong type", () => {
    expect(validateAgainstSchema("str", { type: "object" }).ok).toBe(false)
    expect(validateAgainstSchema({}, { type: "array" }).ok).toBe(false)
    expect(validateAgainstSchema(42, { type: "string" }).ok).toBe(false)
  })

  it("enforces required fields", () => {
    const schema = { type: "object" as const, required: ["name", "count"] }
    expect(validateAgainstSchema({ name: "x" }, schema).ok).toBe(false)
    expect(validateAgainstSchema({ name: "x", count: 1 }, schema).ok).toBe(true)
  })

  it("validates nested properties recursively", () => {
    const schema = {
      type: "object" as const,
      properties: {
        meta: { type: "object" as const, required: ["id"] },
      },
    }
    expect(validateAgainstSchema({ meta: {} }, schema).ok).toBe(false)
    expect(validateAgainstSchema({ meta: { id: "abc" } }, schema).ok).toBe(true)
  })

  it("validates array items", () => {
    const schema = { type: "array" as const, items: { type: "number" as const } }
    expect(validateAgainstSchema([1, 2, 3], schema).ok).toBe(true)
    expect(validateAgainstSchema([1, "x"], schema).ok).toBe(false)
  })

  it("validates integer type", () => {
    expect(validateAgainstSchema(5, { type: "integer" }).ok).toBe(true)
    expect(validateAgainstSchema(5.5, { type: "integer" }).ok).toBe(false)
    expect(validateAgainstSchema("5", { type: "integer" }).ok).toBe(false)
  })
})

describe("validatePayload", () => {
  it("rejects when no schema registered", () => {
    clearCaptureSlot("nonexistent")
    const result = validatePayload("nonexistent", {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.notAvailable).toBe(true)
  })
})

// --- Integration tests for submit_result structured output ---

describe("spawnNode submit_result capture", () => {
  it("(a) valid payload via submit_result → nodeCompleted with captured payload", async () => {
    const { events, dagLayer } = makeEventTracker()
    const schema = { type: "object", required: ["tests_passed", "diff"] }
    const payload = { tests_passed: 10, diff: "abc" }
    await runSpawn(
      dagLayer,
      makePromptLayerWithCapture(reply("ignored text"), [payload], schema),
      schema,
    )
    const completed = events.find((e) => e.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toEqual(payload)
  })

  it("(b) invalid payload then valid retry → nodeCompleted with valid payload", async () => {
    const { events, dagLayer } = makeEventTracker()
    const schema = { type: "object", required: ["status"] }
    await runSpawn(
      dagLayer,
      makePromptLayerWithCapture(reply("text"), [{ wrong: "field" }, { status: "ok" }], schema),
      schema,
    )
    const completed = events.find((e) => e.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toEqual({ status: "ok" })
  })

  it("(c) schema declared, no submit_result call → nodeFailed with verdict_fail", async () => {
    const { events, dagLayer } = makeEventTracker()
    const schema = { type: "object" }
    registerCaptureSlot("ses_child", schema)
    await runSpawn(dagLayer, makePromptLayer(reply("some text")), schema)
    const failed = events.find((e) => e.type === "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.reason).toContain("submit_result")
    expect(failed!.trigger).toBe("verdict_fail")
  })

  it("(d) no schema → last text part as output", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("Task completed")))
    const completed = events.find((e) => e.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toBe("Task completed")
  })

  it("fails a diff review whose result targets a stale implementation fingerprint", async () => {
    const { events, dagLayer } = makeEventTracker()
    const schema = {
      type: "object",
      properties: {
        verdict: { enum: ["ACCEPT", "REJECT"] },
        implementation_fingerprint: { type: "string" },
      },
      required: ["verdict", "implementation_fingerprint"],
    }
    await runSpawn(
      dagLayer,
      makePromptLayerWithCapture(reply("ignored text"), [{
        verdict: "ACCEPT",
        implementation_fingerprint: "sha256:revision-1",
      }], schema),
      schema,
      { reviewImplementationFingerprint: "sha256:revision-2" },
    )

    expect(events.find((event) => event.type === "nodeCompleted")).toBeUndefined()
    expect(events.find((event) => event.type === "nodeFailed")).toEqual({
      type: "nodeFailed",
      nodeID: "node-1",
      reason: "Review result contract failed: review result fingerprint sha256:revision-1 does not match current implementation sha256:revision-2",
      trigger: "verdict_fail",
    })
  })
})
