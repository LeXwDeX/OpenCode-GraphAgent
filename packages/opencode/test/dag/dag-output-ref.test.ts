// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- spawn-level
// probes deliberately mirror dag-structured-output.test.ts: mocked service
// layers and row fixtures use `as never` type shims (mock objects implement
// only the interface slice the scenario exercises). The shims are type-only;
// converting them would fork the template's shape without changing behavior.
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Train B probes — node-output file references (workflows/dag-engine-optimization.md,
 * v1.0.15 ledger, decisions B1–B4).
 *
 * Dual track (B1): report nodes without an output_schema may submit an absolute
 * file path instead of inlining long text; output_schema nodes keep inline JSON.
 * At submit time the runtime validates existence + size>0 and records
 * `{content_ref, size, sha256}` in captured_output (B2); on first capture into
 * the project `.opencode/` report area the runtime ensures the `.gitignore`
 * entry exists (B4, append, never overwrite). The report area convention is
 * `.opencode/workflow-reports/` — no better-fit existing directory was found
 * under `.opencode/` (checked the worktree; naming mirrors the existing
 * `.opencode/workflow-drafts/` convention).
 *
 * NOTE: the run's evidence.md was not present in the worktree, the config
 * workflow repo, or the opencode data dir when this train started — the probe
 * contract below is derived directly from the settled ledger above.
 *
 * Probe map:
 * - B-p1: submit-time absolute-path detection — a child reply that IS an
 *   absolute path to an existing non-empty regular file captures a file_ref
 *   record ({kind, content_ref, path, size, sha256, summary}) into
 *   captured_output while nodeCompleted keeps the path string as the inline
 *   output (backward compatible: input mapping, wake digests, and legacy
 *   readers all see the same string they always did). RED on the unmodified
 *   engine: non-schema nodes never write captured_output.
 * - B-p2 (PIN): output_schema settlement is untouched — a captured payload
 *   containing an absolute-path string stays inline JSON, no file_ref rewrite.
 *   Green before AND after the feature.
 * - B-p4: `.gitignore` auto-entry — a capture whose ref path lies inside
 *   <directory>/.opencode/workflow-reports/ appends the report-area entry to
 *   <directory>/.gitignore exactly once, preserving pre-existing entries. RED
 *   on the unmodified engine: nothing touches the project `.gitignore`.
 */
import { afterAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer, Semaphore } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { registerCaptureSlot, validatePayload } from "@/dag/runtime/capture"
import { captureOutputFileRef, ensureReportAreaGitignore, REPORT_AREA } from "@/dag/runtime/output-ref"
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

function makeEventTracker() {
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
      Effect.sync(() => {
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
    expect(completed!.output).toBe(reportPath)
    expect(capturedCalls).toHaveLength(1)
    expect(capturedCalls[0]).toEqual({
      kind: "file_ref",
      content_ref: reportPath,
      path: reportPath,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      summary: `${content.slice(0, 200)}\u2026`,
    })
  })

  it("B-p1(a2) keeps the full text as summary when the file is at most 200 chars", async () => {
    const dir = await tmpRoot("dag-ref-")
    const content = "short report"
    const reportPath = path.join(dir, "short.md")
    await Bun.write(reportPath, content)
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply(reportPath)))
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe(reportPath)
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
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe(reportPath)
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
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe(reportPath)
    expect(await fs.readFile(path.join(projectDir, ".gitignore"), "utf8")).toBe("node_modules\n")
  })
})

describe("output-ref module rules (Train B, post-feature units)", () => {
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
