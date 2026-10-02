import { describe, expect, test } from "bun:test"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "../../../core/test/fixture/tmpdir"
import { Context, Effect, Fiber, Layer, Schema, Semaphore } from "effect"
import { Dag, StaleMessageInputError } from "@/dag/dag"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID, PartID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { spawnNode } from "@/dag/runtime/spawn"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"

function reply(text: string): SessionV1.WithParts {
  const id = MessageID.ascending(),
    sessionID = SessionID.make("ses_child")
  return {
    info: {
      id,
      sessionID,
      parentID: MessageID.ascending(),
      role: "assistant",
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), sessionID, messageID: id, type: "text", text }],
  }
}
type Case = {
  artifactPath?: string
  staleReceipt?: boolean
  structured?: boolean
  queued?: number
  undeliverable?: number
  stopReason?: string
  replaced?: boolean
  paused?: boolean
  cancelled?: boolean
  modelError?: boolean
  deadline?: boolean
  replaceWhilePaused?: boolean
}
async function exercise(options: Case = {}) {
  let node = makeNodeRow({
    status: "pending",
    capturedOutput: { result: "old" },
    capturedOutputPresent: true,
    capturedSnapshotID: "old-snapshot",
  })
  let workflow = makeWorkflowRow({ directory: process.cwd() })
  let receipts = 0
  let created = 0,
    loops = 0,
    prompts = 0,
    completions = 0,
    toolWrites = 0
  const events: { type: string; output?: unknown; reason?: string }[] = []
  const initial = reply(options.artifactPath ?? "old"),
    updated = reply(options.artifactPath ?? "updated")
  if (options.modelError && initial.info.role === "assistant")
    initial.info.error = { name: "UnknownError", data: { message: "blocked" } }
  const storeLayer = Layer.mock(DagStore.Service, {
    tryClaimAdoption: () => Effect.succeed(true),
    getNode: () => Effect.succeed(node),
    getWorkflow: () => Effect.succeed(workflow),
    setCapturedOutput: (_id, output, snapshot) =>
      Effect.sync(() => {
        node = { ...node, capturedOutput: output, capturedOutputPresent: true, capturedSnapshotID: snapshot }
      }),
  })
  const dagLayer = Layer.effect(
    Dag.Service,
    Effect.gen(function* () {
      const store = yield* DagStore.Service
      return yield* Layer.build(
        Layer.mock(Dag.Service, {
          store,
          nodeQueued: () =>
            Effect.sync(() => {
              node = { ...node, status: "queued" }
            }),
          nodeStarted: () =>
            Effect.sync(() => {
              node = { ...node, status: "running", childSessionId: "ses_child" }
            }),
          nodeCompleted: (_dag, _node, output) =>
            Effect.gen(function* () {
              completions++
              if (completions === 1 && !options.staleReceipt) {
                if (options.replaced) node = { ...node, replanAttempts: 1, childSessionId: "ses_replaced" }
                if (options.paused || options.replaceWhilePaused) workflow = { ...workflow, status: "paused" }
                if (options.deadline) node = { ...node, deadlineMs: Date.now() - 1 }
                if (options.cancelled) workflow = { ...workflow, status: "cancelled" }
                yield* new StaleMessageInputError({ dagID: "dag_live", nodeID: "node-1", reason: "stale_input" })
              }
              node = { ...node, status: "completed" }
              events.push({ type: "completed", output })
            }),
          nodeFailed: (_dag, _node, reason) =>
            Effect.sync(() => {
              node = { ...node, status: "failed" }
              events.push({ type: "failed", reason })
            }),
        }),
      ).pipe(Effect.map((context) => Context.get(context, Dag.Service)))
    }),
  ).pipe(Layer.provide(storeLayer))
  const guard: DagMessages.Interface["guard"] = (_caller, _input, commit) =>
    Effect.gen(function* () {
      receipts++
      if (options.staleReceipt && receipts === 1) return { ok: false as const, reason: "stale_input" as const }
      return { ok: true as const, value: yield* commit }
    })
  const messagesLayer = Layer.mock(DagMessages.Service, {
    guard,
    snapshotForTurn: (_caller, id) =>
      Effect.succeed({
        ok: true,
        value: {
          id: id === initial.info.id ? "old-snapshot" : "updated-snapshot",
          mailboxID: "box",
          logicalTurnID: id,
          revision: id === initial.info.id ? 0 : 1,
          messages: [],
          associated: true,
          ...(options.stopReason ? { stopReason: options.stopReason } : {}),
        },
      }),
    revisions: () =>
      Effect.succeed({
        ok: true,
        value: {
          endpoint: { id: "box", kind: "node", sessionID: "ses_child" },
          accepted: 1,
          snapshot: 0,
          queued: options.queued ?? 1,
          delivered: 0,
          undeliverable: options.undeliverable ?? 0,
        },
      }),
  })
  const agentLayer = Layer.mock(Agent.Service, {
    get: () =>
      Effect.succeed({
        name: "build",
        mode: "all",
        permission: [],
        options: {},
        description: "",
        prompt: "",
        tools: {},
        hooks: {},
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      }),
  })
  const decoded = Schema.decodeUnknownSync(Session.Info)({
    id: "ses_parent",
    projectID: "proj_test",
    slug: "test",
    directory: process.cwd(),
    title: "test",
    version: "test",
    agent: "build",
    permission: [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ],
    time: { created: 1, updated: 1 },
  })
  const info: Session.Info = {
    id: decoded.id,
    projectID: decoded.projectID,
    slug: decoded.slug,
    directory: decoded.directory,
    title: decoded.title,
    version: decoded.version,
    agent: "build",
    permission: [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ],
    time: { created: decoded.time.created, updated: decoded.time.updated },
  }
  const sessionsLayer = Layer.mock(Session.Service, {
    get: () => Effect.succeed(info),
    create: () =>
      Effect.sync(() => {
        created++
        return { ...info, id: SessionID.make("ses_child") }
      }),
  })
  const next = Effect.sync(() => {
    node = { ...node, capturedOutput: { result: "updated" }, capturedSnapshotID: "updated-snapshot" }
    return updated
  })
  const promptLayer = Layer.mock(SessionPrompt.Service, {
    prompt: () =>
      Effect.gen(function* () {
        prompts++
        if (prompts === 1) {
          toolWrites++
          return initial
        }
        return yield* next
      }),
    loop: () =>
      Effect.gen(function* () {
        loops++
        return yield* next
      }),
    cancel: () => Effect.void,
  })
  const layer = Layer.mergeAll(dagLayer, agentLayer, sessionsLayer, promptLayer, messagesLayer)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const spawned = yield* spawnNode(Semaphore.makeUnsafe(1), {
          dagID: "dag_live",
          nodeID: "node-1",
          node: makeNodeRow(),
          parentSessionID: "ses_parent",
          promptParts: [{ type: "text", text: "work" }],
          ...(options.structured ? { outputSchema: { type: "object" } } : {}),
        })
        if (options.paused || options.deadline || options.replaceWhilePaused)
          yield* Effect.forkChild(
            Effect.sleep(300).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  workflow = { ...workflow, status: "running" }
                  if (options.deadline) node = { ...node, deadlineMs: Date.now() + 60_000 }
                  if (options.replaceWhilePaused) node = { ...node, replanAttempts: 1, childSessionId: "ses_replaced" }
                }),
              ),
            ),
          )
        yield* Fiber.join(spawned.fiber)
      }),
    ).pipe(Effect.provide(layer)),
  )
  return { events, created, loops, prompts, toolWrites, node, receipts }
}

describe("live durable message continuation", () => {
  test("stale file receipt is rejected before capture, then same child persists current receipt", async () => {
    await using tmp = await tmpdir()
    const artifactPath = path.join(tmp.path, "report.txt")
    await writeFile(artifactPath, "current report")
    const r = await exercise({ artifactPath, staleReceipt: true })
    expect(r).toMatchObject({ loops: 1, receipts: 2, created: 1, toolWrites: 1 })
    expect(r.events[0]?.type).toBe("completed")
    expect(r.node.capturedOutput).toMatchObject({ kind: "file_ref", source_path: artifactPath })
  })
  test("expired live deadline waits for durable extension before another model call", async () => {
    const r = await exercise({ deadline: true })
    expect(r.loops).toBe(1)
    expect(r.events[0]?.output).toBe("updated")
  })
  test("attempt replacement during pause prevents an old continuation", async () => {
    const r = await exercise({ replaceWhilePaused: true })
    expect(r.loops).toBe(0)
    expect(r.events).toEqual([])
  })
  test("late plain input continues the same child without repeating completed tools", async () => {
    const r = await exercise()
    expect(r).toMatchObject({ created: 1, loops: 1, prompts: 1, toolWrites: 1 })
    expect(r.events).toEqual([{ type: "completed", output: "updated" }])
  })
  test("structured capture is refreshed by the same child continuation", async () => {
    const r = await exercise({ structured: true })
    expect(r.events).toEqual([{ type: "completed", output: { result: "updated" } }])
    expect(r.created).toBe(1)
    expect(r.loops).toBe(1)
  })
  test("consumed structured input requires resubmission without replaying tool writes", async () => {
    const r = await exercise({ structured: true, queued: 0 })
    expect(r).toMatchObject({ prompts: 2, loops: 0, toolWrites: 1 })
    expect(r.events[0]?.type).toBe("completed")
  })
  test("budget exhaustion cannot reset through a message continuation", async () => {
    const r = await exercise({ stopReason: "budget_exhausted" })
    expect(r.loops).toBe(0)
    expect(r.events[0]).toMatchObject({ type: "failed" })
    expect(r.events[0]?.reason).toContain("budget_exhausted")
  })
  test("attempt replacement abandons the old callback", async () => {
    const r = await exercise({ replaced: true })
    expect(r.events).toEqual([])
    expect(r.loops).toBe(0)
    expect(r.node.childSessionId).toBe("ses_replaced")
  })
  test("paused workflow holds continuation until resume", async () => {
    const r = await exercise({ paused: true })
    expect(r.loops).toBe(1)
    expect(r.events[0]?.output).toBe("updated")
  })
  test("cancellation prevents provider continuation", async () => {
    const r = await exercise({ cancelled: true })
    expect(r.loops).toBe(0)
    expect(r.events).toEqual([])
  })
  test("discarded input cannot admit an extra model turn", async () => {
    const r = await exercise({ queued: 0, undeliverable: 1 })
    expect(r.loops).toBe(0)
    expect(r.events[0]?.reason).toContain("unavailable")
  })
  test("a failed model result never publishes success", async () => {
    const r = await exercise({ modelError: true })
    expect(r.loops).toBe(0)
    expect(r.events[0]).toMatchObject({ type: "failed" })
  })
})
