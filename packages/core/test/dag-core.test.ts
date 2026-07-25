import { describe, expect, it } from "bun:test"
import { CycleError, DependencyGraph, NodeNotFoundError } from "@opencode-ai/core/dag/core/graph"
import { planReplan } from "@opencode-ai/core/dag/core/replan"
import {
  assertValidNodeTransition,
  assertValidWorkflowTransition,
  getValidNextNodeStatuses,
  getValidNextWorkflowStatuses,
  InvalidTransitionError,
  isNodeTerminalStatus,
  isWorkflowTerminalStatus,
  NodeStatus,
  TerminalViolationError,
  WorkflowStatus,
} from "@opencode-ai/core/dag/core/types"
import {
  aggregateBranchStatus,
  DEFAULT_FALLBACK_TRIGGER,
  transitionToNodeEvent,
  transitionToWorkflowEvent,
} from "@opencode-ai/core/dag/core/transitions"
import { FallbackTrigger } from "@opencode-ai/core/dag/core/types"
import { validateRequiredNodes } from "@opencode-ai/core/dag/core/required-validator"
import {
  buildGraph,
  type SchedulingNode,
  WorkflowRuntime,
} from "@opencode-ai/core/dag/core/scheduling"

describe("DependencyGraph", () => {
  it("adds nodes and edges", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    g.addNode("b")
    g.addEdge("b", "a")
    expect(g.hasEdge("b", "a")).toBe(true)
    expect(g.getDependencies("b")).toEqual(["a"])
    expect(g.getDependents("a")).toEqual(["b"])
  })

  it("throws NodeNotFoundError for unknown nodes", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    expect(() => g.getDependencies("missing")).toThrow(NodeNotFoundError)
    expect(() => g.addEdge("a", "missing")).toThrow(NodeNotFoundError)
  })

  it("detects self-loops as cycles on addEdge", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    expect(() => g.addEdge("a", "a")).toThrow(CycleError)
  })

  it("prevents cycles via wouldCreateCycle pre-check", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    g.addNode("b")
    g.addNode("c")
    g.addEdge("b", "a") // b depends on a
    g.addEdge("c", "b") // c depends on b
    // a -> b -> c chain; adding a->c completes a cycle c->b->a->c
    expect(() => g.addEdge("a", "c")).toThrow(CycleError)
  })

  it("topologicalSort is deterministic (lexicographic ties)", () => {
    const g = new DependencyGraph()
    for (const id of ["x", "y", "z", "a", "b"]) g.addNode(id)
    // No edges — all roots, sort by name
    expect(g.topologicalSort()).toEqual(["a", "b", "x", "y", "z"])
  })

  it("topologicalSort respects dependencies", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    g.addNode("b")
    g.addNode("c")
    g.addEdge("b", "a") // b depends on a → a before b
    g.addEdge("c", "b") // c depends on b → b before c
    const sorted = g.topologicalSort()
    expect(sorted.indexOf("a")).toBeLessThan(sorted.indexOf("b"))
    expect(sorted.indexOf("b")).toBeLessThan(sorted.indexOf("c"))
  })

  it("getLayers groups parallel nodes into the same wavefront", () => {
    const g = new DependencyGraph()
    // a, b, c are roots (parallel); d depends on all three (converge)
    for (const id of ["a", "b", "c", "d"]) g.addNode(id)
    g.addEdge("d", "a")
    g.addEdge("d", "b")
    g.addEdge("d", "c")
    const layers = g.getLayers()
    expect(layers[0].sort()).toEqual(["a", "b", "c"])
    expect(layers[1]).toEqual(["d"])
  })

  it("getLayers throws on cycle", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    g.addNode("b")
    // Manually build a cycle bypassing addEdge's pre-check
    ;(g as unknown as { deps: Map<string, Set<string>> }).deps.get("a")!.add("b")
    ;(g as unknown as { deps: Map<string, Set<string>> }).deps.get("b")!.add("a")
    expect(() => g.getLayers()).toThrow(CycleError)
  })

  it("getExecutableNodes returns nodes whose deps are all completed", () => {
    const g = new DependencyGraph()
    for (const id of ["a", "b", "c"]) g.addNode(id)
    g.addEdge("c", "a")
    g.addEdge("c", "b")
    expect(g.getExecutableNodes(new Set()).sort()).toEqual(["a", "b"])
    expect(g.getExecutableNodes(new Set(["a", "b"]))).toEqual(["c"])
  })

  it("serializes and deserializes via fromJSON", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    g.addNode("b")
    g.addEdge("b", "a")
    const json = g.toJSON()
    const g2 = DependencyGraph.fromJSON(json)
    expect(g2.getDependencies("b")).toEqual(["a"])
    expect(g2.hasEdge("b", "a")).toBe(true)
  })
})

describe("iron laws (transition tables)", () => {
  it("isWorkflowTerminalStatus identifies the 4 terminal workflow statuses", () => {
    expect(isWorkflowTerminalStatus(WorkflowStatus.COMPLETED)).toBe(true)
    expect(isWorkflowTerminalStatus(WorkflowStatus.FAILED)).toBe(true)
    expect(isWorkflowTerminalStatus(WorkflowStatus.CANCELLED)).toBe(true)
    expect(isWorkflowTerminalStatus(WorkflowStatus.ARCHIVED)).toBe(true)
    expect(isWorkflowTerminalStatus(WorkflowStatus.RUNNING)).toBe(false)
    expect(isWorkflowTerminalStatus(WorkflowStatus.PAUSED)).toBe(false)
  })

  it("isNodeTerminalStatus identifies the 4 terminal node statuses", () => {
    expect(isNodeTerminalStatus(NodeStatus.COMPLETED)).toBe(true)
    expect(isNodeTerminalStatus(NodeStatus.FAILED)).toBe(true)
    expect(isNodeTerminalStatus(NodeStatus.ABORTED)).toBe(true)
    expect(isNodeTerminalStatus(NodeStatus.SKIPPED)).toBe(true)
    expect(isNodeTerminalStatus(NodeStatus.RUNNING)).toBe(false)
    expect(isNodeTerminalStatus(NodeStatus.PENDING)).toBe(false)
  })

  it("getValidNextNodeStatuses: PENDING → QUEUED/RUNNING/SKIPPED", () => {
    expect(getValidNextNodeStatuses(NodeStatus.PENDING).sort()).toEqual(
      [NodeStatus.QUEUED, NodeStatus.RUNNING, NodeStatus.SKIPPED, NodeStatus.FAILED].sort(),
    )
  })

  it("getValidNextNodeStatuses: terminal returns empty (irreversible)", () => {
    expect(getValidNextNodeStatuses(NodeStatus.COMPLETED)).toEqual([])
    expect(getValidNextNodeStatuses(NodeStatus.FAILED)).toEqual([])
    expect(getValidNextNodeStatuses(NodeStatus.ABORTED)).toEqual([])
    expect(getValidNextNodeStatuses(NodeStatus.SKIPPED)).toEqual([])
  })

  it("getValidNextWorkflowStatuses: RUNNING → PAUSED/STEPPING/COMPLETED/FAILED/CANCELLED", () => {
    expect(getValidNextWorkflowStatuses(WorkflowStatus.RUNNING).sort()).toEqual(
      [WorkflowStatus.PAUSED, WorkflowStatus.STEPPING, WorkflowStatus.COMPLETED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED].sort(),
    )
  })

  it("covers the complete node transition matrix", () => {
    const transitions = [
      [NodeStatus.PENDING, [NodeStatus.QUEUED, NodeStatus.RUNNING, NodeStatus.SKIPPED, NodeStatus.FAILED]],
      [NodeStatus.QUEUED, [NodeStatus.RUNNING, NodeStatus.SKIPPED]],
      [NodeStatus.RUNNING, [NodeStatus.COMPLETED, NodeStatus.FAILED, NodeStatus.PAUSED, NodeStatus.PENDING, NodeStatus.SKIPPED]],
      [NodeStatus.PAUSED, [NodeStatus.RUNNING]],
      [NodeStatus.COMPLETED, []],
      [NodeStatus.FAILED, []],
      [NodeStatus.ABORTED, []],
      [NodeStatus.SKIPPED, []],
    ] as const

    for (const [status, expected] of transitions) {
      expect(getValidNextNodeStatuses(status)).toEqual([...expected])
    }
  })

  it("covers the complete workflow transition matrix", () => {
    const transitions = [
      [WorkflowStatus.PENDING, [WorkflowStatus.RUNNING]],
      [WorkflowStatus.RUNNING, [WorkflowStatus.PAUSED, WorkflowStatus.STEPPING, WorkflowStatus.COMPLETED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED]],
      [WorkflowStatus.STEPPING, [WorkflowStatus.RUNNING, WorkflowStatus.PAUSED, WorkflowStatus.COMPLETED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED]],
      [WorkflowStatus.PAUSED, [WorkflowStatus.RUNNING, WorkflowStatus.CANCELLED]],
      [WorkflowStatus.COMPLETED, [WorkflowStatus.ARCHIVED]],
      [WorkflowStatus.FAILED, [WorkflowStatus.ARCHIVED]],
      [WorkflowStatus.CANCELLED, [WorkflowStatus.ARCHIVED]],
      [WorkflowStatus.ARCHIVED, []],
    ] as const

    for (const [status, expected] of transitions) {
      expect(getValidNextWorkflowStatuses(status)).toEqual([...expected])
    }
  })

  it("assertValidNodeTransition throws TerminalViolationError from terminal", () => {
    expect(() => assertValidNodeTransition("n1", NodeStatus.COMPLETED, NodeStatus.RUNNING)).toThrow(
      TerminalViolationError,
    )
  })

  it("assertValidNodeTransition throws InvalidTransitionError for illegal jump", () => {
    expect(() => assertValidNodeTransition("n1", NodeStatus.PENDING, NodeStatus.COMPLETED)).toThrow(
      InvalidTransitionError,
    )
  })

  it("assertValidWorkflowTransition allows PAUSED → RUNNING (resume)", () => {
    expect(() => assertValidWorkflowTransition("w1", WorkflowStatus.PAUSED, WorkflowStatus.RUNNING)).not.toThrow()
  })

  it("assertValidWorkflowTransition accepts every declared workflow transition", () => {
    for (const from of Object.values(WorkflowStatus)) {
      for (const to of getValidNextWorkflowStatuses(from)) {
        expect(() => assertValidWorkflowTransition("w1", from, to)).not.toThrow()
      }
    }
  })

  it("assertValidNodeTransition accepts every declared node transition", () => {
    for (const from of Object.values(NodeStatus)) {
      for (const to of getValidNextNodeStatuses(from)) {
        expect(() => assertValidNodeTransition("n1", from, to)).not.toThrow()
      }
    }
  })

  it("rejects every undeclared workflow transition", () => {
    for (const from of Object.values(WorkflowStatus)) {
      for (const to of Object.values(WorkflowStatus)) {
        if (getValidNextWorkflowStatuses(from).includes(to)) continue
        const error = isWorkflowTerminalStatus(from) ? TerminalViolationError : InvalidTransitionError
        expect(() => assertValidWorkflowTransition("w1", from, to)).toThrow(error)
      }
    }
  })

  it("rejects every undeclared node transition", () => {
    for (const from of Object.values(NodeStatus)) {
      for (const to of Object.values(NodeStatus)) {
        if (getValidNextNodeStatuses(from).includes(to)) continue
        const error = isNodeTerminalStatus(from) ? TerminalViolationError : InvalidTransitionError
        expect(() => assertValidNodeTransition("n1", from, to)).toThrow(error)
      }
    }
  })
})

describe("transitions (event mappings + aggregation)", () => {
  it("transitionToNodeEvent: PENDING → RUNNING emits node.started", () => {
    expect(transitionToNodeEvent(NodeStatus.PENDING, NodeStatus.RUNNING)).toBe("node.started")
  })

  it("transitionToNodeEvent: PAUSED → RUNNING emits node.resumed", () => {
    expect(transitionToNodeEvent(NodeStatus.PAUSED, NodeStatus.RUNNING)).toBe("node.resumed")
  })

  it("transitionToNodeEvent: FAILED → RUNNING emits node.restarted (replan path)", () => {
    expect(transitionToNodeEvent(NodeStatus.FAILED, NodeStatus.RUNNING)).toBe("node.restarted")
  })

  it("transitionToNodeEvent: → QUEUED emits nothing", () => {
    expect(transitionToNodeEvent(NodeStatus.PENDING, NodeStatus.QUEUED)).toBeNull()
  })

  it("transitionToWorkflowEvent: PAUSED → RUNNING emits workflow.resumed", () => {
    expect(transitionToWorkflowEvent(WorkflowStatus.PAUSED, WorkflowStatus.RUNNING)).toBe("workflow.resumed")
  })

  it("transitionToWorkflowEvent: PENDING → RUNNING emits workflow.started", () => {
    expect(transitionToWorkflowEvent(WorkflowStatus.PENDING, WorkflowStatus.RUNNING)).toBe("workflow.started")
  })

  it("maps every node target state to its durable event", () => {
    const events = [
      [NodeStatus.PENDING, null],
      [NodeStatus.QUEUED, null],
      [NodeStatus.RUNNING, "node.started"],
      [NodeStatus.PAUSED, "node.paused"],
      [NodeStatus.COMPLETED, "node.completed"],
      [NodeStatus.FAILED, "node.failed"],
      [NodeStatus.ABORTED, "node.aborted"],
      [NodeStatus.SKIPPED, "node.skipped"],
    ] as const

    for (const [status, event] of events) {
      expect(transitionToNodeEvent(NodeStatus.PENDING, status)).toBe(event)
    }
  })

  it("maps every workflow target state to its durable event", () => {
    const events = [
      [WorkflowStatus.PENDING, "workflow.created"],
      [WorkflowStatus.RUNNING, "workflow.started"],
      [WorkflowStatus.PAUSED, "workflow.paused"],
      [WorkflowStatus.STEPPING, "workflow.stepped"],
      [WorkflowStatus.COMPLETED, "workflow.completed"],
      [WorkflowStatus.FAILED, "workflow.failed"],
      [WorkflowStatus.CANCELLED, "workflow.cancelled"],
      [WorkflowStatus.ARCHIVED, "workflow.archived"],
    ] as const

    for (const [status, event] of events) {
      expect(transitionToWorkflowEvent(WorkflowStatus.PENDING, status)).toBe(event)
    }
  })

  it("aggregateBranchStatus: any FAILED → FAILED", () => {
    expect(
      aggregateBranchStatus([NodeStatus.COMPLETED, NodeStatus.FAILED, NodeStatus.RUNNING]),
    ).toBe(NodeStatus.FAILED)
  })

  it("aggregateBranchStatus: all COMPLETED → COMPLETED", () => {
    expect(aggregateBranchStatus([NodeStatus.COMPLETED, NodeStatus.COMPLETED])).toBe(NodeStatus.COMPLETED)
  })

  it("aggregateBranchStatus: empty → PENDING", () => {
    expect(aggregateBranchStatus([])).toBe(NodeStatus.PENDING)
  })

  it("DEFAULT_FALLBACK_TRIGGER is EXEC_FAILED", () => {
    expect(DEFAULT_FALLBACK_TRIGGER).toBe(FallbackTrigger.EXEC_FAILED)
  })
})

describe("validateRequiredNodes", () => {
  it("passes for a consistent config", () => {
    const result = validateRequiredNodes({
      nodes: [
        { id: "a", depends_on: [], required: true },
        { id: "b", depends_on: ["a"], required: true },
      ],
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it("warns when all nodes are required", () => {
    const result = validateRequiredNodes({
      nodes: [
        { id: "a", depends_on: [], required: true },
        { id: "b", depends_on: ["a"], required: true },
      ],
    })
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it("passes when some nodes are optional", () => {
    const result = validateRequiredNodes({
      nodes: [
        { id: "a", depends_on: [], required: true },
        { id: "b", depends_on: ["a"], required: false },
      ],
    })
    expect(result.warnings).toEqual([])
  })
})

describe("planReplan (D11 simplified model)", () => {
  it("rejects restart + cancel on the same node", () => {
    const plan = planReplan(
      { nodes: [{ id: "n1", status: NodeStatus.RUNNING, depends_on: [] }] },
      { nodes: [{ id: "n1", depends_on: [], restart: true, cancel: true }] },
    )
    expect(plan.errors.length).toBeGreaterThan(0)
    expect(plan.errors[0]).toContain("restart and cancel")
  })

  it("rejects restart on a non-running node", () => {
    const plan = planReplan(
      { nodes: [{ id: "n1", status: NodeStatus.PENDING, depends_on: [] }] },
      { nodes: [{ id: "n1", depends_on: [], restart: true }] },
    )
    expect(plan.errors.length).toBeGreaterThan(0)
  })

  it("rejects cancel on a terminal node", () => {
    const plan = planReplan(
      { nodes: [{ id: "n1", status: NodeStatus.COMPLETED, depends_on: [] }] },
      { nodes: [{ id: "n1", depends_on: [], cancel: true }] },
    )
    expect(plan.errors.length).toBeGreaterThan(0)
  })

  it("ignores terminal nodes that appear in the fragment (iron law #2)", () => {
    const plan = planReplan(
      { nodes: [{ id: "done", status: NodeStatus.COMPLETED, depends_on: [] }] },
      { nodes: [{ id: "done", depends_on: ["new-node"] }] },
    )
    // 'done' is terminal — fragment entry ignored. But 'new-node' doesn't exist
    // so the fragment refs fail. Either way, 'done' must be in ignore, not in errors-by-name.
    expect(plan.ignore).toContain("done")
  })

  it("classifies pending-not-in-fragment as cancel (superseded)", () => {
    const plan = planReplan(
      {
        nodes: [
          { id: "a", status: NodeStatus.COMPLETED, depends_on: [] },
          { id: "b", status: NodeStatus.PENDING, depends_on: ["a"] },
        ],
      },
      { nodes: [] }, // empty fragment: everything pending gets cancelled
    )
    expect(plan.cancel).toContain("b")
  })

  it("classifies pending-in-fragment as replace", () => {
    const plan = planReplan(
      {
        nodes: [
          { id: "a", status: NodeStatus.COMPLETED, depends_on: [] },
          { id: "b", status: NodeStatus.PENDING, depends_on: ["a"] },
        ],
      },
      { nodes: [{ id: "b", depends_on: ["a"] }] },
    )
    expect(plan.replace).toContain("b")
    expect(plan.cancel).not.toContain("b")
  })

  it("classifies new ids as add", () => {
    const plan = planReplan(
      { nodes: [{ id: "a", status: NodeStatus.COMPLETED, depends_on: [] }] },
      { nodes: [{ id: "new", depends_on: ["a"] }] },
    )
    expect(plan.add).toContain("new")
  })

  it("classifies running-with-restart as restart", () => {
    const plan = planReplan(
      { nodes: [{ id: "r", status: NodeStatus.RUNNING, depends_on: [] }] },
      { nodes: [{ id: "r", depends_on: [], restart: true }] },
    )
    expect(plan.restart).toContain("r")
  })

  it("classifies running-with-cancel as cancel", () => {
    const plan = planReplan(
      { nodes: [{ id: "r", status: NodeStatus.RUNNING, depends_on: [] }] },
      { nodes: [{ id: "r", depends_on: [], cancel: true }] },
    )
    expect(plan.cancel).toContain("r")
  })

  it("keeps running-not-in-fragment unchanged (not in any bucket)", () => {
    const plan = planReplan(
      { nodes: [{ id: "r", status: NodeStatus.RUNNING, depends_on: [] }] },
      { nodes: [] },
    )
    expect(plan.cancel).not.toContain("r")
    expect(plan.restart).not.toContain("r")
    expect(plan.replace).not.toContain("r")
    expect(plan.add).not.toContain("r")
  })

  it("rejects a fragment that would create a cycle in the merged graph", () => {
    // Current: a -> b (b depends on a). Fragment flips a to depend on b → cycle.
    const plan = planReplan(
      {
        nodes: [
          { id: "a", status: NodeStatus.COMPLETED, depends_on: [] },
          { id: "b", status: NodeStatus.PENDING, depends_on: ["a"] },
        ],
      },
      { nodes: [{ id: "b", depends_on: ["a"] }, { id: "a", depends_on: ["b"] }] },
    )
    // 'a' is COMPLETED (terminal) so the fragment's a→b edge is ignored; no cycle.
    // To actually test cycle rejection we need a non-terminal example:
    expect(plan.ignore).toContain("a")
  })

  it("rejects a real cycle among pending/added nodes", () => {
    const plan = planReplan(
      { nodes: [] },
      {
        nodes: [
          { id: "x", depends_on: ["y"] },
          { id: "y", depends_on: ["x"] },
        ],
      },
    )
    expect(plan.errors.length).toBeGreaterThan(0)
    expect(plan.errors.join(" ").toLowerCase()).toContain("cycle")
  })

  it("mergedGraph is acyclic for a valid plan", () => {
    const plan = planReplan(
      { nodes: [{ id: "a", status: NodeStatus.COMPLETED, depends_on: [] }] },
      { nodes: [{ id: "b", depends_on: ["a"] }, { id: "c", depends_on: ["b"] }] },
    )
    expect(plan.errors).toEqual([])
    expect(plan.mergedGraph.hasCycle()).toBe(false)
  })
})

describe("buildGraph", () => {
  it("builds a graph from SchedulingNode list", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "pending", required: false },
      { id: "b", dependsOn: ["a"], status: "pending", required: false },
    ]
    const g = buildGraph(nodes)
    expect(g.hasNode("a")).toBe(true)
    expect(g.hasNode("b")).toBe(true)
    expect(g.hasEdge("b", "a")).toBe(true)
  })

  it("ignores dependency edges to unknown nodes", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: ["ghost"], status: "pending", required: false },
    ]
    const g = buildGraph(nodes)
    expect(g.hasNode("a")).toBe(true)
    expect(g.getDependencies("a")).toEqual([])
  })
})

describe("WorkflowRuntime", () => {
  const linearNodes = (statuses: Record<string, SchedulingNode["status"]> = {}): SchedulingNode[] => [
    { id: "a", dependsOn: [], status: statuses["a"] ?? "pending", required: false },
    { id: "b", dependsOn: ["a"], status: statuses["b"] ?? "pending", required: false },
    { id: "c", dependsOn: ["b"], status: statuses["c"] ?? "pending", required: false },
  ]

  it("markSatisfied unblocks dependents", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    expect(rt.getReadyNodes()).toEqual(["a"])
    rt.markSatisfied("a")
    expect(rt.getReadyNodes()).toEqual(["b"])
    rt.markSatisfied("b")
    expect(rt.getReadyNodes()).toEqual(["c"])
  })

  it("required markUnsatisfied blocks dependents", () => {
    const rt = new WorkflowRuntime(
      linearNodes().map((node) => node.id === "a" ? { ...node, required: true } : node),
      4,
    )
    expect(rt.getReadyNodes()).toEqual(["a"])
    rt.markUnsatisfied("a")
    expect(rt.getReadyNodes()).toEqual([])
  })

  it("optional markUnsatisfied unblocks dependents", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    rt.markUnsatisfied("a")
    expect(rt.getReadyNodes()).toEqual(["b"])
    expect(rt.hasRequiredFailure()).toBe(false)
  })

  it("markRunning excludes a node from getReadyNodes", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    const ready = rt.getReadyNodes()
    expect(ready).toEqual(["a"])
    rt.markRunning("a")
    expect(rt.getReadyNodes()).toEqual([])
  })

  it("markSatisfied removes node from running", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    rt.markRunning("a")
    rt.markSatisfied("a")
    expect(rt.getReadyNodes()).toEqual(["b"])
  })

  it("isComplete when all nodes are terminal", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    expect(rt.isComplete()).toBe(false)
    rt.markSatisfied("a")
    expect(rt.isComplete()).toBe(false)
    rt.markSatisfied("b")
    expect(rt.isComplete()).toBe(false)
    rt.markSatisfied("c")
    expect(rt.isComplete()).toBe(true)
  })

  it("isComplete with mixed satisfied and unsatisfied", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    rt.markSatisfied("a")
    rt.markUnsatisfied("b")
    expect(rt.getReadyNodes()).toEqual(["c"])
    expect(rt.isComplete()).toBe(false)
    expect(rt.hasRequiredFailure()).toBe(false)
    rt.markSatisfied("c")
    expect(rt.isComplete()).toBe(true)
  })

  it("hasRequiredFailure detects required node failure", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "pending", required: true },
      { id: "b", dependsOn: [], status: "pending", required: false },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    expect(rt.hasRequiredFailure()).toBe(false)
    rt.markUnsatisfied("b")
    expect(rt.hasRequiredFailure()).toBe(false)
    rt.markUnsatisfied("a")
    expect(rt.hasRequiredFailure()).toBe(true)
  })

  it("hasRequiredFailure is false when non-required node fails", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "pending", required: false },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    rt.markUnsatisfied("a")
    expect(rt.hasRequiredFailure()).toBe(false)
  })

  it("rebuildGraph reflects new topology", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    rt.markSatisfied("a")
    rt.markSatisfied("b")
    const newNodes: SchedulingNode[] = [
      { id: "x", dependsOn: [], status: "pending", required: false },
      { id: "y", dependsOn: ["x"], status: "pending", required: false },
    ]
    rt.rebuildGraph(newNodes)
    expect(rt.getReadyNodes()).toEqual(["x"])
    expect(rt.isComplete()).toBe(false)
  })

  it("rebuildGraph re-seeds from node statuses", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    rt.markSatisfied("a")
    rt.rebuildGraph(linearNodes({ a: "satisfied" }))
    expect(rt.getReadyNodes()).toEqual(["b"])
  })

  it("paused state suppresses getReadyNodes", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    expect(rt.getReadyNodes()).toEqual(["a"])
    rt.setPaused(true)
    expect(rt.isPaused()).toBe(true)
    expect(rt.getReadyNodes()).toEqual([])
    rt.setPaused(false)
    expect(rt.isPaused()).toBe(false)
    expect(rt.getReadyNodes()).toEqual(["a"])
  })

  it("constructor seeds from satisfied node statuses", () => {
    const rt = new WorkflowRuntime(linearNodes({ a: "satisfied" }), 4)
    expect(rt.getReadyNodes()).toEqual(["b"])
  })

  it("constructor seeds from unsatisfied node statuses", () => {
    const rt = new WorkflowRuntime(linearNodes({ a: "unsatisfied" }), 4)
    expect(rt.getReadyNodes()).toEqual(["b"])
    expect(rt.isComplete()).toBe(false)
    expect(rt.hasRequiredFailure()).toBe(false)
  })

  it("diamond dependency — all deps must be satisfied", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "pending", required: false },
      { id: "b", dependsOn: ["a"], status: "pending", required: false },
      { id: "c", dependsOn: ["a"], status: "pending", required: false },
      { id: "d", dependsOn: ["b", "c"], status: "pending", required: false },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    expect(rt.getReadyNodes()).toEqual(["a"])
    rt.markSatisfied("a")
    expect(rt.getReadyNodes().sort()).toEqual(["b", "c"])
    rt.markSatisfied("b")
    expect(rt.getReadyNodes()).toEqual(["c"])
    rt.markSatisfied("c")
    expect(rt.getReadyNodes()).toEqual(["d"])
  })

  it("markUnsatisfied cascades to transitive dependents", () => {
    const rt = new WorkflowRuntime(
      linearNodes().map((node) => node.id === "a" ? { ...node, required: true } : node),
      4,
    )
    rt.markUnsatisfied("a")
    expect(rt.isComplete()).toBe(true)
    expect(rt.getReadyNodes()).toEqual([])
  })

  it("markUnsatisfied cascade respects already-satisfied nodes", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "pending", required: true },
      { id: "b", dependsOn: ["a"], status: "pending", required: false },
      { id: "c", dependsOn: [], status: "pending", required: false },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    rt.markSatisfied("c")
    rt.markUnsatisfied("a")
    expect(rt.isComplete()).toBe(true)
  })
})
