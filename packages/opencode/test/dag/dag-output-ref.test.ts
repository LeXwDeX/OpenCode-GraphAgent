// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- spawn-level
// probes deliberately mirror dag-structured-output.test.ts: mocked service
// layers and row fixtures use `as never` type shims (mock objects implement
// only the interface slice the scenario exercises). The shims are type-only;
// converting them would fork the template's shape without changing behavior.
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * File-output settlement probes. New schemaless file submissions commit
 * immutable managed objects before success; legacy detection and inline JSON
 * remain compatible. Both live capture and crash recovery verify receipts.
 */
import { afterAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer, Semaphore } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { registerCaptureSlot, validatePayload } from "@/dag/runtime/capture"
import { captureOutputFileRef, commitOutputFileRef, verifyOutputFileRef, ensureReportAreaGitignore, REPORT_AREA } from "@/dag/runtime/output-ref"
import { makeNodeRow } from "./fixtures"
import type { DagStore } from "@opencode-ai/core/dag/store"

const tmpRoots: string[] = []

function tmpRoot(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix)).then((dir) => {
    tmpRoots.push(dir)
    return dir
  })
}

afterAll(async () => {
  for (const dir of tmpRoots) await fs.rm(dir, { recursive: true, force: true })
})

type TrackedEvent = { type: string; nodeID: string; output?: unknown; reason?: string; trigger?: string }

let capturedStore: Map<string, unknown> = new Map()
let capturedCalls: unknown[] = []

function makeEventTracker(options: { capturedFail?: boolean } = {}) {
  const events: TrackedEvent[] = []
  capturedStore = new Map()
  capturedCalls = []
  const storeStub: Partial<DagStore.Interface> = {
    tryClaimAdoption: () => Effect.succeed(true),
    getNode: Effect.fn("s")((_workflowID: string, nodeID: string) =>
      Effect.sync(() => ({
        ...makeNodeRow({ id: nodeID, status: "running", childSessionId: "ses_child" }),
        capturedOutput: capturedStore.get(nodeID),
      }))),
    setCapturedOutput: Effect.fn("s")((_childSessionID: string, payload: unknown) =>
      options.capturedFail ? Effect.die(new Error("receipt persistence failed")) : Effect.sync(() => {
        capturedCalls.push(payload)
        capturedStore.set("node-1", payload)
      })),
  }
  const dagLayer = Layer.mock(Dag.Service, {
    store: storeStub as DagStore.Interface,
    nodeQueued: Effect.fn("s")((_dagID: string, _nodeID: string) => Effect.void),
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
    name: "build", mode: "all", permission: [{ permission: "*", pattern: "*", action: "allow" }], options: {}, description: "", prompt: "",
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

// Train A cast idiom: the extra `directory` field is cast away pre-feature so
// the probe compiles against the baseline NodeSpawnInput while offering the
// post-feature seam (gitignore guarantee keyed on the workflow directory).
const directoryOverride = (directory: string) =>
  ({ directory }) as unknown as Partial<NodeSpawnInput>

describe("submit-time absolute-path capture (Train B, B-p1)", () => {
  it("B-p1(a) captures {content_ref, size, sha256} when the reply IS an existing non-empty absolute path", async () => {
    const dir = await tmpRoot("dag-ref-")
    const content = `${"report line\n".repeat(40)}SENTINEL`
    const reportPath = path.join(dir, "report.md")
    await Bun.write(reportPath, content)
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)))
    const completed = events.find((event) => event.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).not.toBe(reportPath)
    expect(capturedCalls).toHaveLength(1)
    expect(capturedCalls[0]).toEqual(expect.objectContaining({
      kind: "file_ref",
      storage: "managed-v1",
      source_path: FSUtil.normalizePath(reportPath),
      content_ref: completed!.output,
      path: completed!.output,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      summary: `${content.slice(0, 200)}\u2026`,
    }))
    await fs.writeFile(reportPath, "overwritten source")
    expect(await fs.readFile(String(completed!.output), "utf8")).toBe(content)
    await fs.rm(dir, { recursive: true, force: true })
    expect(await fs.readFile(String(completed!.output), "utf8")).toBe(content)
  })

  it("does not complete when the managed receipt cannot be persisted", async () => {
    const dir = await tmpRoot("dag-ref-persist-")
    const reportPath = path.join(dir, "report.md")
    await Bun.write(reportPath, "receipt persistence regression")
    const { events, dagLayer } = makeEventTracker({ capturedFail: true })
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)))
    expect(events.some((event) => event.type === "nodeCompleted")).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: "nodeFailed", trigger: "exec_failed" }))
  })

  it("checks input artifacts again after waiting for a concurrency permit", async () => {
    const dir = await tmpRoot("dag-ref-queued-")
    const source = path.join(dir, "report.md")
    await fs.writeFile(source, `queued artifact ${dir}`)
    const ref = await Effect.runPromise(commitOutputFileRef(source, {
      workflow_id: "wf-1", node_id: "producer", child_session_id: "ses_producer", replan_attempt: 0,
    }))
    if (!ref) throw new Error("missing input artifact")
    tmpRoots.push(path.dirname(ref.path))
    const { events, dagLayer } = makeEventTracker()
    const semaphore = Semaphore.makeUnsafe(1)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* semaphore.take(1)
      const spawned = yield* spawnNode(semaphore, makeSpawnInput(undefined, { directory: dir, inputArtifacts: [ref] }))
      yield* Effect.promise(() => fs.chmod(ref.path, 0o600))
      yield* Effect.promise(() => fs.unlink(ref.path))
      yield* semaphore.release(1)
      yield* Fiber.await(spawned.fiber)
    })).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessionLayer, makePromptLayer(reply("must not execute")))) ) as Effect.Effect<void, Error>)
    expect(events.some((event) => event.type === "nodeCompleted")).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: "nodeFailed", reason: expect.stringContaining("Managed DAG artifact unavailable") }))
  })

  it("B-p1(a2) keeps the full text as summary when the file is at most 200 chars", async () => {
    const dir = await tmpRoot("dag-ref-")
    const content = "short report"
    const reportPath = path.join(dir, "short.md")
    await Bun.write(reportPath, content)
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toEqual(expect.stringContaining("workflow-artifacts"))
    expect(capturedCalls).toHaveLength(1)
    expect(capturedCalls[0]).toEqual(expect.objectContaining({ summary: "short report", size: Buffer.byteLength(content) }))
  })

  it("B-p1(b) leaves output inline when the absolute path does not exist", async () => {
    const ghostPath = path.join(os.tmpdir(), `dag-ref-ghost-${Date.now()}.md`)
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(ghostPath)))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe(ghostPath)
    expect(capturedCalls).toHaveLength(0)
  })

  it("B-p1(c) leaves output inline when the file exists but is empty", async () => {
    const dir = await tmpRoot("dag-ref-")
    const emptyPath = path.join(dir, "empty.md")
    await Bun.write(emptyPath, "")
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(emptyPath)))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe(emptyPath)
    expect(capturedCalls).toHaveLength(0)
  })

  it("B-p1(d) leaves output inline when the reply mentions a path inside prose", async () => {
    const dir = await tmpRoot("dag-ref-")
    const reportPath = path.join(dir, "report.md")
    await Bun.write(reportPath, "prose-embedded report")
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(`Report written to ${reportPath}`)))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe(`Report written to ${reportPath}`)
    expect(capturedCalls).toHaveLength(0)
  })

  it("B-p1(e) leaves output inline for a plain-text reply (baseline behavior)", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("Task completed")))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe("Task completed")
    expect(capturedCalls).toHaveLength(0)
  })

  it("B-p1(f) leaves output inline when the reply is a directory path", async () => {
    const dir = await tmpRoot("dag-ref-")
    const subDir = path.join(dir, "subdir")
    await fs.mkdir(subDir)
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(subDir)))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe(subDir)
    expect(capturedCalls).toHaveLength(0)
  })
})

describe("output_schema dual track (Train B, B-p2 pin)", () => {
  it("B-p2 keeps a captured payload containing an absolute path as inline JSON (no file_ref rewrite)", async () => {
    const dir = await tmpRoot("dag-ref-")
    const reportPath = path.join(dir, "schema-report.md")
    await Bun.write(reportPath, "schema node report")
    const { events, dagLayer } = makeEventTracker()
    const schema = { type: "object" as const, required: ["report"] }
    const payload = { report: reportPath }
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      prompt: () => Effect.gen(function* () {
        registerCaptureSlot("ses_child", schema)
        const result = validatePayload("ses_child", payload)
        if (result.ok) capturedStore.set("node-1", payload)
        return reply("ignored text")
      }),
    })
    await runSpawn(dagLayer, promptLayer, schema)
    const completed = events.find((event) => event.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toEqual(payload)
  })
})

describe("report-area gitignore entry (Train B, B-p4)", () => {
  it("B-p4(a) appends the report-area entry to the project .gitignore on first capture into the report area", async () => {
    const projectDir = await tmpRoot("dag-ref-proj-")
    await Bun.write(path.join(projectDir, "existing-code.ts"), "export const x = 1\n")
    const reportArea = path.join(projectDir, ".opencode", "workflow-reports")
    await fs.mkdir(reportArea, { recursive: true })
    const reportPath = path.join(reportArea, "run-1.md")
    await Bun.write(reportPath, "# report\n")
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)), undefined, directoryOverride(projectDir))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toEqual(expect.stringContaining("workflow-artifacts"))
    const gitignore = await fs.readFile(path.join(projectDir, ".gitignore"), "utf8")
    expect(gitignore.split("\n").map((line) => line.trim())).toContain(".opencode/workflow-reports/")
  })

  it("B-p4(b) is append-only and idempotent: pre-existing entries survive, the report entry lands exactly once", async () => {
    const projectDir = await tmpRoot("dag-ref-proj-")
    await Bun.write(path.join(projectDir, ".gitignore"), "node_modules\n*.log\n")
    const reportArea = path.join(projectDir, ".opencode", "workflow-reports")
    await fs.mkdir(reportArea, { recursive: true })
    const reportPath = path.join(reportArea, "run-2.md")
    await Bun.write(reportPath, "# report 2\n")
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)), undefined, directoryOverride(projectDir))
    expect(events.find((event) => event.type === "nodeCompleted")).toBeDefined()
    const { events: secondEvents, dagLayer: secondDagLayer } = makeEventTracker()
    await runSpawn(secondDagLayer, makePromptLayer(reply(reportPath)), undefined, directoryOverride(projectDir))
    expect(secondEvents.find((event) => event.type === "nodeCompleted")).toBeDefined()
    const gitignore = await fs.readFile(path.join(projectDir, ".gitignore"), "utf8")
    const lines = gitignore.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
    expect(lines).toContain("node_modules")
    expect(lines).toContain("*.log")
    expect(lines.filter((line) => line === ".opencode/workflow-reports/")).toHaveLength(1)
  })

  it("B-p4(c) does not touch the project .gitignore for refs outside the report area", async () => {
    const projectDir = await tmpRoot("dag-ref-proj-")
    await Bun.write(path.join(projectDir, ".gitignore"), "node_modules\n")
    const outsideDir = await tmpRoot("dag-ref-outside-")
    const reportPath = path.join(outsideDir, "elsewhere.md")
    await Bun.write(reportPath, "# elsewhere\n")
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)), undefined, directoryOverride(projectDir))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toEqual(expect.stringContaining("workflow-artifacts"))
    expect(await fs.readFile(path.join(projectDir, ".gitignore"), "utf8")).toBe("node_modules\n")
  })
})

describe("output-ref module rules (Train B, post-feature units)", () => {
  it("shares immutable objects across captures and detects corruption without repairing over it", async () => {
    const dir = await tmpRoot("dag-managed-object-")
    const source = path.join(dir, "report.md")
    const content = `managed integrity ${dir}`
    await fs.writeFile(source, content)
    const provenance = { workflow_id: "wf-object", node_id: "report", child_session_id: "ses-object", replan_attempt: 0 }
    const first = await Effect.runPromise(commitOutputFileRef(source, provenance))
    const second = await Effect.runPromise(commitOutputFileRef(source, provenance))
    expect(first).toBeDefined()
    expect(second?.path).toBe(first!.path)
    tmpRoots.push(path.dirname(first!.path))
    await fs.chmod(first!.path, 0o600)
    await fs.writeFile(first!.path, "X".repeat(first!.size))
    const verificationError = await Effect.runPromise(verifyOutputFileRef(first).pipe(Effect.flip))
    expect(verificationError.message).toContain("digest mismatch")
    const commitError = await Effect.runPromise(commitOutputFileRef(source, provenance).pipe(Effect.flip))
    expect(commitError.message).toContain("DAG artifact commit failed")
    expect(await fs.readFile(first!.path, "utf8")).toBe("X".repeat(first!.size))
  })

  it("rejects a missing managed object and leaves legacy refs compatible", async () => {
    const dir = await tmpRoot("dag-managed-missing-")
    const source = path.join(dir, "report.md")
    await fs.writeFile(source, `missing artifact ${dir}`)
    const ref = await Effect.runPromise(commitOutputFileRef(source, {
      workflow_id: "wf-missing", node_id: "report", child_session_id: "ses-missing", replan_attempt: 0,
    }))
    expect(ref).toBeDefined()
    tmpRoots.push(path.dirname(ref!.path))
    await fs.chmod(ref!.path, 0o600)
    await fs.unlink(ref!.path)
    const verificationError = await Effect.runPromise(verifyOutputFileRef(ref).pipe(Effect.flip))
    expect(verificationError.message).toContain("Managed DAG artifact unavailable")
    const legacy = await Effect.runPromise(captureOutputFileRef(source))
    await fs.unlink(source)
    await Effect.runPromise(verifyOutputFileRef(legacy))
  })

  it("rejects relative paths and paths containing whitespace even when the file exists", async () => {
    const dir = await tmpRoot("dag-ref-")
    const spacedPath = path.join(dir, "two words.md")
    await Bun.write(spacedPath, "spaced")
    expect(await Effect.runPromise(captureOutputFileRef(` ${spacedPath} `))).toBeUndefined()
    const relative = path.relative(process.cwd(), spacedPath)
    expect(await Effect.runPromise(captureOutputFileRef(relative))).toBeUndefined()
  })

  it("captures cross-worktree refs and normalizes trailing whitespace only", async () => {
    const dir = await tmpRoot("dag-ref-")
    const reportPath = path.join(dir, "cross.md")
    const content = "cross-worktree report"
    await Bun.write(reportPath, content)
    const ref = await Effect.runPromise(captureOutputFileRef(`\n${reportPath}\n`))
    expect(ref).toEqual(expect.objectContaining({
      kind: "file_ref",
      content_ref: reportPath,
      path: reportPath,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      summary: content,
    }))
  })

  it("creates a missing .gitignore with only the report-area entry", async () => {
    const projectDir = await tmpRoot("dag-ref-proj-")
    const refPath = path.join(projectDir, REPORT_AREA, "x.md")
    await Effect.runPromise(ensureReportAreaGitignore(projectDir, refPath))
    expect(await fs.readFile(path.join(projectDir, ".gitignore"), "utf8")).toBe(".opencode/workflow-reports/\n")
  })

  it("separates the entry onto its own line when the existing file lacks a trailing newline", async () => {
    const projectDir = await tmpRoot("dag-ref-proj-")
    await Bun.write(path.join(projectDir, ".gitignore"), "node_modules")
    const refPath = path.join(projectDir, REPORT_AREA, "x.md")
    await Effect.runPromise(ensureReportAreaGitignore(projectDir, refPath))
    expect(await fs.readFile(path.join(projectDir, ".gitignore"), "utf8")).toBe("node_modules\n.opencode/workflow-reports/\n")
  })

  it("leaves the file byte-identical when an entry or a covering .opencode/ rule already exists", async () => {
    for (const covering of [".opencode/workflow-reports/", ".opencode/workflow-reports", ".opencode/", ".opencode"]) {
      const projectDir = await tmpRoot("dag-ref-proj-")
      const before = `${covering}\nkeep-me\n`
      await Bun.write(path.join(projectDir, ".gitignore"), before)
      const refPath = path.join(projectDir, REPORT_AREA, "x.md")
      await Effect.runPromise(ensureReportAreaGitignore(projectDir, refPath))
      expect(await fs.readFile(path.join(projectDir, ".gitignore"), "utf8")).toBe(before)
    }
  })

  it("does not create a .gitignore for refs outside the report area", async () => {
    const projectDir = await tmpRoot("dag-ref-proj-")
    const outsideDir = await tmpRoot("dag-ref-outside-")
    const refPath = path.join(outsideDir, "y.md")
    await Effect.runPromise(ensureReportAreaGitignore(projectDir, refPath))
    expect(await Bun.file(path.join(projectDir, ".gitignore")).exists()).toBe(false)
  })
})
