import { describe, expect, test } from "bun:test"
import {
  computeNodeRowIndex,
  computeWaves,
  dagControlAllowed,
  dagControlProgressMessage,
  dagControlUnavailableMessage,
  dagNodeGlyph,
  dagNodeHistoryLabel,
  dagStatusColor,
  dagWorkflowSessions,
  formatDagDeadline,
  formatDagDuration,
  formatDagError,
  formatDagOutputPreview,
  formatDagProgress,
  mergeDagWorkflowSummaries,
  type DagNode,
} from "../../src/feature-plugins/system/dag-inspector-utils"

const node = (id: string, depends_on: string[] = [], name = id): DagNode => ({
  id,
  workflow_id: "wf-1",
  name,
  status: "pending",
  worker_type: "task",
  required: false,
  depends_on,
  replan_attempts: 0,
})

describe("computeWaves", () => {
  test("empty input produces no waves", () => {
    expect(computeWaves([])).toEqual([])
  })

  test("independent nodes land in one wave sorted by name", () => {
    const waves = computeWaves([node("b"), node("a"), node("c")])
    expect(waves).toHaveLength(1)
    expect(waves[0].map((n) => n.id)).toEqual(["a", "b", "c"])
  })

  test("linear chain produces one wave per node", () => {
    const waves = computeWaves([node("c", ["b"]), node("a"), node("b", ["a"])])
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["a"], ["b"], ["c"]])
  })

  test("diamond topology groups by depth", () => {
    const waves = computeWaves([
      node("root"),
      node("left", ["root"]),
      node("right", ["root"]),
      node("merge", ["left", "right"]),
    ])
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["root"], ["left", "right"], ["merge"]])
  })

  test("dependency cycle terminates and drops only the cycle members", () => {
    const waves = computeWaves([node("a"), node("x", ["y"]), node("y", ["x"])])
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["a"]])
  })

  test("dependency on a missing node is treated as satisfied (replan removed it)", () => {
    const waves = computeWaves([node("a", ["ghost"]), node("b", ["a"])])
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["a"], ["b"]])
  })
})

describe("formatDagError", () => {
  test("removes Effect and provider error wrappers without hiding the useful message", () => {
    expect(
      formatDagError("Cause([Die(ProviderModelNotFoundError: Model not found: local/local/glm. Did you mean: glm?)])"),
    ).toBe("Model not found: local/local/glm. Did you mean: glm?")
  })
})

describe("DAG control state", () => {
  test("allows only operations valid for the current workflow status", () => {
    expect(dagControlUnavailableMessage("running", "pause")).toBeUndefined()
    expect(dagControlUnavailableMessage("stepping", "pause")).toBeUndefined()
    expect(dagControlUnavailableMessage("paused", "resume")).toBeUndefined()
    expect(dagControlUnavailableMessage("completed", "pause")).toBe("Workflow is completed and cannot be paused")
    expect(dagControlUnavailableMessage("cancelled", "cancel")).toBe("Workflow is cancelled and cannot be cancelled")
    expect(dagControlUnavailableMessage("pending", "cancel")).toBe("Workflow is pending and cannot be cancelled")
    expect(dagControlUnavailableMessage("archived", "cancel")).toBe("Workflow is archived and cannot be cancelled")
  })

  test("formats progress without component-level branching", () => {
    expect(dagControlProgressMessage("pause")).toBe("Pausing workflow...")
    expect(dagControlProgressMessage("resume")).toBe("Resuming workflow...")
    expect(dagControlProgressMessage("cancel")).toBe("Cancelling workflow...")
  })

  test("step is available while running or stepping only", () => {
    expect(dagControlUnavailableMessage("running", "step")).toBeUndefined()
    expect(dagControlUnavailableMessage("stepping", "step")).toBeUndefined()
    expect(dagControlUnavailableMessage("paused", "step")).toBe("Workflow is paused and cannot be stepped")
    expect(dagControlProgressMessage("step")).toBe("Stepping workflow...")
  })

  test("dagControlAllowed mirrors the unavailable-message predicate", () => {
    expect(dagControlAllowed("running", "pause")).toBe(true)
    expect(dagControlAllowed("paused", "pause")).toBe(false)
    expect(dagControlAllowed("paused", "resume")).toBe(true)
    expect(dagControlAllowed("running", "resume")).toBe(false)
    expect(dagControlAllowed("paused", "cancel")).toBe(true)
    expect(dagControlAllowed("completed", "cancel")).toBe(false)
    expect(dagControlAllowed(undefined, "pause")).toBe(false)
  })
})

describe("computeNodeRowIndex", () => {
  test("counts wave headers, nodes, and inter-wave spacer rows", () => {
    const layers = computeWaves([node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])])
    // rows: 0 wave1 header, 1 a, 2 spacer, 3 wave2 header, 4 b, 5 c, 6 spacer, 7 wave3 header, 8 d
    expect(computeNodeRowIndex(layers, "a")).toBe(1)
    expect(computeNodeRowIndex(layers, "b")).toBe(4)
    expect(computeNodeRowIndex(layers, "c")).toBe(5)
    expect(computeNodeRowIndex(layers, "d")).toBe(8)
    expect(computeNodeRowIndex(layers, "missing")).toBeUndefined()
  })
})

describe("shared status presentation", () => {
  const theme = { success: "S", error: "E", warning: "W", text: "T", textMuted: "M" }

  test("one status maps to one color across every DAG surface", () => {
    expect(dagStatusColor(theme, "completed")).toBe("S")
    expect(dagStatusColor(theme, "failed")).toBe("E")
    expect(dagStatusColor(theme, "paused")).toBe("W")
    expect(dagStatusColor(theme, "stepping")).toBe("W")
    expect(dagStatusColor(theme, "running")).toBe("M")
    expect(dagStatusColor(theme, "skipped")).toBe("M")
    expect(dagStatusColor(theme, "cancelled")).toBe("M")
  })

  test("node glyphs mirror the todo-item vocabulary", () => {
    expect(dagNodeGlyph("completed")).toBe("✓")
    expect(dagNodeGlyph("failed")).toBe("✗")
    expect(dagNodeGlyph("skipped")).toBe("⊘")
    expect(dagNodeGlyph("queued")).toBe("◌")
    expect(dagNodeGlyph("pending")).toBe("○")
  })
})

describe("node detail formatting", () => {
  test("formats durations and tolerates SDK non-finite sentinels", () => {
    expect(formatDagDuration(1_000, 63_000)).toBe("1m 2s")
    expect(formatDagDuration(1_000, 5_000)).toBe("4s")
    expect(formatDagDuration(undefined, 5_000)).toBeUndefined()
    expect(formatDagDuration("NaN", 5_000)).toBeUndefined()
  })

  test("flattens output previews to one bounded line", () => {
    expect(formatDagOutputPreview("line one\n  line two")).toBe("line one line two")
    expect(formatDagOutputPreview({ verdict: "ACCEPT" })).toBe('{"verdict":"ACCEPT"}')
    expect(formatDagOutputPreview(null)).toBeUndefined()
    expect(formatDagOutputPreview("   ")).toBeUndefined()
    expect(formatDagOutputPreview("x".repeat(300))?.length).toBe(201)
  })

  test("deadline countdown only labels nodes still executing", () => {
    expect(formatDagDeadline("running", 63_000, 1_000)).toBe("1m 2s left")
    expect(formatDagDeadline("queued", 5_000, 1_000)).toBe("4s left")
    expect(formatDagDeadline("running", 1_000, 5_000)).toBe("overdue")
    expect(formatDagDeadline("completed", 63_000, 1_000)).toBeUndefined()
    expect(formatDagDeadline("running", undefined, 1_000)).toBeUndefined()
    expect(formatDagDeadline("running", "Infinity", 1_000)).toBeUndefined()
  })

  test("replan history label appears only after a restart", () => {
    expect(dagNodeHistoryLabel({ replan_attempts: 0 })).toBeUndefined()
    expect(dagNodeHistoryLabel({ replan_attempts: 1 })).toBe("restarted ×1")
    expect(dagNodeHistoryLabel({ replan_attempts: 3 })).toBe("restarted ×3")
  })

  test("progress counts completed+skipped as settled (P2-9)", () => {
    expect(formatDagProgress({ nodeCount: 9, completedNodes: 3, skippedNodes: 4 })).toBe("7/9")
    expect(formatDagProgress({ nodeCount: 2, completedNodes: 0, skippedNodes: 0 })).toBe("0/2")
  })
})

describe("dagWorkflowSessions", () => {
  test("keeps first-seen order and drops duplicate owners", () => {
    expect(
      dagWorkflowSessions([{ session_id: "b" }, { session_id: "a" }, { session_id: "b" }]),
    ).toEqual(["b", "a"])
  })

  test("empty list yields no sessions", () => {
    expect(dagWorkflowSessions([])).toEqual([])
  })
})

describe("mergeDagWorkflowSummaries", () => {
  const summary = (id: string) => ({
    id,
    title: id,
    status: "running",
    nodeCount: 1,
    completedNodes: 0,
    runningNodes: 1,
    failedNodes: 0,
    skippedNodes: 0,
    queuedNodes: 0,
    escalatedNodes: 0,
    graphRev: 1,
  })

  test("orders merged rows by the project list and keeps the list as source of truth", () => {
    const merged = mergeDagWorkflowSummaries([{ id: "b" }, { id: "a" }], [[summary("b")], [summary("a")]])
    expect(merged.map((row) => row.id)).toEqual(["b", "a"])
  })

  test("drops summaries for workflows the list no longer reports", () => {
    const merged = mergeDagWorkflowSummaries([{ id: "a" }], [[summary("a"), summary("ghost")]])
    expect(merged.map((row) => row.id)).toEqual(["a"])
  })

  test("empty discovery inputs merge to nothing", () => {
    expect(mergeDagWorkflowSummaries([], [])).toEqual([])
  })
})
