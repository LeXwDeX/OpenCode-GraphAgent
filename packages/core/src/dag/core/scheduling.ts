import { DependencyGraph } from "./graph"

export type SchedulingNodeStatus = "pending" | "running" | "satisfied" | "unsatisfied"

export interface SchedulingNode {
  readonly id: string
  readonly dependsOn: readonly string[]
  readonly status: SchedulingNodeStatus
  readonly required: boolean
}

export function buildGraph(nodes: SchedulingNode[]): DependencyGraph {
  const graph = new DependencyGraph()
  nodes.forEach((node) => graph.addNode(node.id))
  nodes.forEach((node) =>
    node.dependsOn.forEach((dep) => {
      if (graph.hasNode(dep)) graph.addEdge(node.id, dep)
    }),
  )
  return graph
}

export class WorkflowRuntime {
  private graph: DependencyGraph
  private readonly satisfied: Set<string> = new Set()
  private readonly unsatisfied: Set<string> = new Set()
  private readonly running: Set<string> = new Set()
  private readonly required: Set<string>
  private paused = false
  private stepMode = false
  readonly maxConcurrency: number

  constructor(nodes: SchedulingNode[], maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency
    this.graph = buildGraph(nodes)
    this.required = new Set(nodes.filter((n) => n.required).map((n) => n.id))
    this.seed(nodes)
  }

  private seed(nodes: readonly SchedulingNode[]): void {
    const unsatisfiedIDs = nodes.filter((n) => n.status === "unsatisfied").map((n) => n.id)
    nodes.forEach((node) => {
      if (node.status === "satisfied") this.satisfied.add(node.id)
      else if (node.status === "unsatisfied") this.unsatisfied.add(node.id)
      else if (node.status === "running") this.running.add(node.id)
    })
    unsatisfiedIDs.filter((id) => this.required.has(id)).forEach((id) => this.cascadeUnsatisfied(id))
  }

  markSatisfied(nodeID: string): void {
    this.satisfied.add(nodeID)
    this.running.delete(nodeID)
    this.unsatisfied.delete(nodeID)
  }

  markUnsatisfied(nodeID: string): void {
    this.unsatisfied.add(nodeID)
    this.running.delete(nodeID)
    this.satisfied.delete(nodeID)
    if (this.required.has(nodeID)) this.cascadeUnsatisfied(nodeID)
  }

  private cascadeUnsatisfied(nodeID: string): void {
    const queue = [nodeID]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const dependent of this.graph.getDependents(current)) {
        if (!this.unsatisfied.has(dependent) && !this.satisfied.has(dependent)) {
          this.unsatisfied.add(dependent)
          this.running.delete(dependent)
          queue.push(dependent)
        }
      }
    }
  }

  markRunning(nodeID: string): void {
    this.running.add(nodeID)
  }

  /** Synchronous check: does the runtime track any running node? */
  hasRunning(): boolean {
    return this.running.size > 0
  }

  /** Check if any running node matches the predicate (e.g. has an active fiber). */
  hasRunningMatching(pred: (nodeID: string) => boolean): boolean {
    for (const id of this.running) {
      if (pred(id)) return true
    }
    return false
  }

  /** Returns true if the node is in running or pending (not yet terminal) state. */
  isActive(nodeID: string): boolean {
    return this.running.has(nodeID) || (!this.satisfied.has(nodeID) && !this.unsatisfied.has(nodeID))
  }

  getReadyNodes(): string[] {
    if (this.paused) return []
    const ready = this.graph
      .getExecutableNodes(new Set([
        ...this.satisfied,
        ...[...this.unsatisfied].filter((id) => !this.required.has(id)),
      ]))
      .filter((id) => !this.satisfied.has(id) && !this.unsatisfied.has(id) && !this.running.has(id))
    if (this.stepMode && ready.length > 0) return [ready.slice().sort()[0]]
    return ready
  }

  isComplete(): boolean {
    return this.graph.getAllNodes().every((id) => this.satisfied.has(id) || this.unsatisfied.has(id))
  }

  hasRequiredFailure(): boolean {
    for (const id of this.unsatisfied) {
      if (this.required.has(id)) return true
    }
    return false
  }

  rebuildGraph(nodes: SchedulingNode[]): void {
    this.graph = buildGraph(nodes)
    this.satisfied.clear()
    this.unsatisfied.clear()
    this.running.clear()
    this.required.clear()
    nodes.filter((n) => n.required).forEach((n) => this.required.add(n.id))
    this.seed(nodes)
  }

  isPaused(): boolean {
    return this.paused
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  isStepMode(): boolean {
    return this.stepMode
  }

  setStepMode(stepMode: boolean): void {
    this.stepMode = stepMode
  }
}
