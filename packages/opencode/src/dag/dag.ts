export * as Dag from "./dag"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { DateTime, Effect, Layer, Context, Schema, Option } from "effect"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { validateRequiredNodes } from "@opencode-ai/core/dag/core/required-validator"
import { buildGraph, WorkflowRuntime, toSchedulingNodes } from "@opencode-ai/core/dag/core/scheduling"
import { CycleError } from "@opencode-ai/core/dag/core/graph"
import { planReplan } from "@opencode-ai/core/dag/core/replan"
import {
  getValidNextWorkflowStatuses,
  getValidNextNodeStatuses,
  isWorkflowTerminalStatus,
  isNodeTerminalStatus,
  InvalidTransitionError,
  TerminalViolationError,
  WorkflowStatus,
  NodeStatus,
} from "@opencode-ai/core/dag/core/types"
import {
  AdmissionRecord,
  ExecutionMode,
  transitionAdmission,
  validateAdmission,
} from "./admission"
import { unresolvedReviewOutcomes, validateReviewLifecycle } from "./review-lifecycle"
import { conditionReference } from "./runtime/eval"

// Re-export domain types
export const ID = DagEvent.DagID
export type ID = typeof ID.Type
export const NodeID = DagEvent.NodeID
export type NodeID = typeof NodeID.Type

export const DEFAULT_WORKFLOW_CONFIG = {
  maxConcurrency: 5,
  maxNodeReplanAttempts: 5,
  maxTotalNodes: 100,
  nodeTimeoutMs: 10 * 60 * 1000,
  nodeRequired: false,
  reportToParent: false,
} as const

/** A node as declared in the workflow's YAML config. */
export interface NodeConfig {
  id: string
  name: string
  worker_type: string
  depends_on: string[]
  required: boolean
  prompt_template: { id?: string; inline?: string; input?: Record<string, unknown> }
  worker_config?: { timeout_ms?: number }
  input_mapping?: Record<string, string>
  report_to_parent?: boolean
  condition?: string
  model?: { modelID: string; providerID: string }
  restart?: boolean
  cancel?: boolean
  output_schema?: Record<string, unknown>
  review?: {
    phase: "design" | "diff"
    implementation_node_id?: string
    verification_node_id?: string
  }
}

export interface NodeDefaults {
  required?: boolean
  worker_config?: { timeout_ms?: number }
  report_to_parent?: boolean
  model?: { modelID: string; providerID: string }
}

export interface WorkflowConfig {
  name: string
  mode?: ExecutionMode
  admission?: AdmissionRecord
  max_concurrency?: number
  max_node_replan_attempts?: number
  max_total_nodes?: number
  node_defaults?: NodeDefaults
  nodes: NodeConfig[]
}

export class ReviewGateError extends Error {
  readonly dagID: string
  readonly reviewIDs: string[]

  constructor(dagID: string, reviewIDs: string[]) {
    super(`Cannot complete deep workflow ${dagID}: unresolved review outcome(s): ${reviewIDs.join(", ")}`)
    this.name = "ReviewGateError"
    this.dagID = dagID
    this.reviewIDs = reviewIDs
  }
}

export function normalizeModel(model: NodeConfig["model"]) {
  if (!model) return undefined
  const prefix = `${model.providerID}/`
  if (!model.modelID.startsWith(prefix)) return model
  const modelID = model.modelID.slice(prefix.length)
  if (!modelID) return model
  return {
    ...model,
    modelID,
  }
}

function normalizeNodeDefaults(defaults: NodeDefaults | undefined): NodeDefaults {
  return {
    required: defaults?.required ?? DEFAULT_WORKFLOW_CONFIG.nodeRequired,
    worker_config: {
      timeout_ms: defaults?.worker_config?.timeout_ms ?? DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs,
    },
    report_to_parent: defaults?.report_to_parent ?? DEFAULT_WORKFLOW_CONFIG.reportToParent,
    ...(defaults?.model ? { model: normalizeModel(defaults.model) } : {}),
  }
}

function normalizeNodeConfig(node: NodeConfig, defaults: NodeDefaults): NodeConfig {
  const model = normalizeModel(node.model ?? defaults.model)
  return {
    ...node,
    required: node.required ?? defaults.required ?? DEFAULT_WORKFLOW_CONFIG.nodeRequired,
    worker_config: {
      ...defaults.worker_config,
      ...node.worker_config,
      timeout_ms: node.worker_config?.timeout_ms ?? defaults.worker_config?.timeout_ms ?? DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs,
    },
    report_to_parent: node.report_to_parent ?? defaults.report_to_parent ?? DEFAULT_WORKFLOW_CONFIG.reportToParent,
    ...(model ? { model } : {}),
  }
}

function normalizeWorkflowConfig(config: WorkflowConfig): WorkflowConfig {
  const defaults = normalizeNodeDefaults(config.node_defaults)
  return {
    ...config,
    mode: config.mode ?? "standard",
    max_concurrency: config.max_concurrency ?? DEFAULT_WORKFLOW_CONFIG.maxConcurrency,
    max_node_replan_attempts: config.max_node_replan_attempts ?? DEFAULT_WORKFLOW_CONFIG.maxNodeReplanAttempts,
    max_total_nodes: config.max_total_nodes ?? DEFAULT_WORKFLOW_CONFIG.maxTotalNodes,
    node_defaults: defaults,
    nodes: config.nodes.map((node) => normalizeNodeConfig(node, defaults)),
  }
}

/**
 * Merge the current workflow config with a replan fragment, applying the plan
 * buckets (cancel / restart / replace / add) to produce the single-source-of-truth
 * post-replan config. Pure function — no I/O.
 *
 * - cancelled nodes are removed
 * - replaced nodes take the fragment's definition
 * - restarted (running) nodes take the fragment's definition (restart = new def)
 * - added nodes (new ids from fragment) are appended
 * - terminal + running-unchanged nodes keep their current definition
 */
export function computeMergedConfig(
  current: WorkflowConfig,
  fragment: { nodes: NodeConfig[] },
  plan: { cancel: string[]; restart: string[]; replace: string[]; add: string[] },
): WorkflowConfig {
  const fragmentById = new Map(fragment.nodes.map((n) => [n.id, n]))
  const cancelSet = new Set(plan.cancel)
  const restartSet = new Set(plan.restart)
  const replaceSet = new Set(plan.replace)
  const surviving = current.nodes
    .filter((n) => !cancelSet.has(n.id))
    .map((n) =>
      restartSet.has(n.id) || replaceSet.has(n.id)
        ? fragmentById.get(n.id) ?? n
        : n,
    )
  const added = plan.add.map((id) => fragmentById.get(id)).filter((n): n is NodeConfig => n !== undefined)
  return { ...current, nodes: [...surviving, ...added] }
}

const parseJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export function parseWorkflowConfig(raw: string): WorkflowConfig | undefined {
  const parsed = parseJsonOption(raw)
  if (Option.isNone(parsed) || typeof parsed.value !== "object" || parsed.value === null) return undefined
  return parsed.value as WorkflowConfig
}

/**
 * A parseable condition may only reference the node's direct dependencies —
 * anything else silently resolves to undefined and evaluates false at spawn
 * time. Shared by create (all nodes) and replan (fragment nodes).
 */
function conditionReferenceErrors(nodes: readonly NodeConfig[]): string[] {
  return nodes.flatMap((node) => {
    const ref = conditionReference(node.condition)
    if (!ref || node.depends_on.includes(ref)) return []
    return [
      `node "${node.id}" condition references "${ref}" which is not in its depends_on (condition inputs come from direct dependencies only; this would silently evaluate false)`,
    ]
  })
}

export interface Interface {
  readonly create: (input: {
    projectID: string
    sessionID: string
    title: string
    config: WorkflowConfig
  }) => Effect.Effect<ID, Error>
  readonly store: DagStore.Interface
  readonly pause: (dagID: string) => Effect.Effect<void, Error>
  readonly resume: (dagID: string) => Effect.Effect<void, Error>
  readonly step: (dagID: string) => Effect.Effect<{ status: "stepping"; nodeID?: string } | { status: "no_ready_nodes" }, Error>
  readonly cancel: (dagID: string) => Effect.Effect<void, Error>
  readonly complete: (dagID: string) => Effect.Effect<void, Error>
  readonly fail: (dagID: string, reason: string) => Effect.Effect<void, Error>
  readonly replan: (dagID: string, fragment: { nodes: NodeConfig[] }) => Effect.Effect<
    { cancel: string[]; restart: string[]; replace: string[]; add: string[]; ignore: string[] },
    Error
  >
  readonly extend: (dagID: string, nodes: NodeConfig[]) => Effect.Effect<
    { cancel: string[]; restart: string[]; replace: string[]; add: string[]; ignore: string[] },
    Error
  >
  readonly nodeQueued: (dagID: string, nodeID: string, deadlineMs?: number) => Effect.Effect<void, Error>
  readonly nodeStarted: (dagID: string, nodeID: string, childSessionID: string, deadlineMs?: number, wakeEligible?: boolean) => Effect.Effect<void, Error>
  readonly nodeCompleted: (dagID: string, nodeID: string, output: unknown) => Effect.Effect<void, Error>
  readonly nodeFailed: (dagID: string, nodeID: string, reason: string, trigger: string) => Effect.Effect<void, Error>
  readonly nodeSkipped: (dagID: string, nodeID: string, reason: string) => Effect.Effect<void, Error>
  readonly nodeCancelled: (dagID: string, nodeID: string) => Effect.Effect<void, Error>
  readonly nodeRestarted: (dagID: string, nodeID: string, childSessionID: string) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Dag") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service
    const workflowLocks = KeyedMutex.makeUnsafe<string>()
    const withWorkflowLock = (dagID: string) => workflowLocks.withLock(dagID)

    const guardWorkflow = Effect.fn("Dag.guardWorkflow")(function* (dagID: string, target: WorkflowStatus) {
      const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!wf) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      const current = wf.status as WorkflowStatus
      if (!getValidNextWorkflowStatuses(current).includes(target)) {
        return yield* Effect.fail(new InvalidTransitionError(dagID, current, target))
      }
    })

    const guardWorkflowNotTerminal = Effect.fn("Dag.guardWorkflowNotTerminal")(function* (dagID: string, attemptedStatus: string) {
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      if (isWorkflowTerminalStatus(workflow.status as WorkflowStatus)) {
        return yield* Effect.fail(new TerminalViolationError(dagID, workflow.status, attemptedStatus))
      }
      return workflow
    })

    const guardNode = Effect.fn("Dag.guardNode")(function* (dagID: string, nodeID: string, target: NodeStatus) {
      yield* guardWorkflowNotTerminal(dagID, target)
      const node = yield* store.getNode(dagID, nodeID).pipe(Effect.orDie)
      if (!node) return yield* Effect.fail(new Error(`Node not found: ${nodeID}`))
      const current = node.status as NodeStatus
      if (isNodeTerminalStatus(current)) {
        return yield* Effect.fail(new TerminalViolationError(nodeID, current, target))
      }
      if (!getValidNextNodeStatuses(current).includes(target)) {
        return yield* Effect.fail(new InvalidTransitionError(nodeID, current, target))
      }
    })

    const create = Effect.fn("Dag.create")(function* (input: {
      projectID: string
      sessionID: string
      title: string
      config: WorkflowConfig
    }) {
      const config = normalizeWorkflowConfig(input.config)
      // Structural validation first (mirrors planReplan's fragment checks so
      // create and replan reject the same malformed shapes): duplicate ids
      // would silently merge via the projector's upsert, and a dangling
      // depends_on reference would silently drop the edge in buildGraph —
      // turning a typo'd dependency into an immediately-runnable root node.
      const ids = config.nodes.map((n) => n.id)
      const idSet = new Set(ids)
      if (idSet.size !== ids.length) {
        const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
        return yield* Effect.fail(new Error(`Invalid workflow config: duplicate node ids: ${duplicates.join(", ")}`))
      }
      const danglingDeps = config.nodes.flatMap((n) =>
        n.depends_on.filter((dep) => !idSet.has(dep)).map((dep) => `node "${n.id}" depends on unknown node "${dep}"`),
      )
      if (danglingDeps.length > 0) {
        return yield* Effect.fail(new Error(`Invalid workflow config: ${danglingDeps.join("; ")}`))
      }
      const conditionErrors = conditionReferenceErrors(config.nodes)
      if (conditionErrors.length > 0) {
        return yield* Effect.fail(new Error(`Invalid workflow config: ${conditionErrors.join("; ")}`))
      }
      // Enforce the total node ceiling at creation, not only on replan — the
      // ceiling is a lifetime cap and the initial graph counts toward it.
      const maxTotalNodes = config.max_total_nodes ?? DEFAULT_WORKFLOW_CONFIG.maxTotalNodes
      if (config.nodes.length > maxTotalNodes) {
        return yield* Effect.fail(new Error(`Total node ceiling exceeded: ${config.nodes.length} nodes > ${maxTotalNodes} max`))
      }
      if (config.mode === "deep") {
        if (!config.admission) {
          return yield* Effect.fail(new Error(
            "Deep workflow admission blocked: admission is required; complete parent-session QA or provide an informed waiver",
          ))
        }
        const admission = validateAdmission(config.admission)
        const stateAccepted = config.admission.state === "READY" || config.admission.state === "WAIVED"
        if (!admission.valid || !stateAccepted) {
          const errors = [
            ...(!stateAccepted
              ? [`state ${config.admission.state} cannot start a deep workflow; expected READY or WAIVED`]
              : []),
            ...(!admission.valid ? admission.errors : []),
            ...config.admission.brief.blocking_questions,
          ]
          return yield* Effect.fail(new Error(
            `Deep workflow admission blocked: ${errors.join("; ")}. Answer blockers, reduce scope, use standard mode, or provide an informed waiver`,
          ))
        }
      }
      const durableConfig = config.mode === "deep" && config.admission
        ? {
            ...config,
            admission: {
              ...config.admission,
              state: transitionAdmission(config.admission.state, "CONSUMED"),
            },
          }
        : config
      const reviewLifecycle = validateReviewLifecycle(durableConfig)
      if (!reviewLifecycle.valid) {
        return yield* Effect.fail(new Error(
          `Invalid review lifecycle: ${reviewLifecycle.errors.join("; ")}`,
        ))
      }
      for (const warning of reviewLifecycle.warnings) {
        yield* Effect.logWarning("DAG review lifecycle diagnostic", { warning })
      }
      const validation = validateRequiredNodes({
        nodes: durableConfig.nodes.map((n) => ({ id: n.id, depends_on: n.depends_on, required: n.required })),
      })
      if (!validation.valid) return yield* Effect.fail(new Error(`Invalid workflow config: ${validation.errors.join("; ")}`))

      // Full-graph cycle detection — validates ALL nodes (not just required),
      // so a cycle among optional nodes cannot silently create a zombie graph.
      // buildGraph throws CycleError via addEdge's wouldCreateCycle pre-check.
      const cyclePath: string[] | null = yield* Effect.sync(() => {
        try {
          const graph = buildGraph(
            durableConfig.nodes.map((n) => ({ id: n.id, dependsOn: n.depends_on, status: "pending" as const, required: n.required })),
          )
          return graph.hasCycle() ? (graph.findCycles()[0] ?? null) : null
        } catch (e) {
          if (e instanceof CycleError) return e.cycle
          throw e
        }
      })
      if (cyclePath) {
        return yield* Effect.fail(new Error(`Workflow config contains a dependency cycle: ${cyclePath.join(" -> ")}`))
      }

      const dagID = DagEvent.DagID.create()
      const ts = yield* DateTime.now
      yield* events.publish(DagEvent.WorkflowCreated, {
        dagID,
        projectID: input.projectID as never,
        sessionID: input.sessionID as never,
        title: input.title,
        config: JSON.stringify(durableConfig),
        status: "pending",
        timestamp: ts,
      })
      for (const node of durableConfig.nodes) {
        yield* events.publish(DagEvent.NodeRegistered, {
          dagID,
          nodeID: node.id as never,
          name: node.name,
          workerType: node.worker_type,
          dependsOn: node.depends_on.map((d) => d as never),
          required: node.required,
          model: node.model as never,
          timestamp: ts,
        })
      }
      const startTs = yield* DateTime.now
      yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: startTs })
      return dagID
    })

    const pause = Effect.fn("Dag.pause")(function* (dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.PAUSED)
      yield* events.publish(DagEvent.WorkflowPaused, { dagID: dagID as ID, timestamp: yield* DateTime.now })
    })
    const resume = Effect.fn("Dag.resume")(function* (dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.RUNNING)
      yield* events.publish(DagEvent.WorkflowResumed, { dagID: dagID as ID, timestamp: yield* DateTime.now })
    })

    const step = Effect.fn("Dag.step")(function* (dagID: string) {
      // Guard: only `running` → `stepping` is valid.
      yield* guardWorkflow(dagID, WorkflowStatus.STEPPING)
      // Reject if a node is still in-flight (one-at-a-time stepping).
      const nodes = yield* store.getNodes(dagID)
      const hasInFlight = nodes.some((n) => n.status === "running")
      if (hasInFlight) return yield* Effect.fail(new Error(`Node still in-flight: cannot step ${dagID}`))
      // Compute ready nodes using a transient WorkflowRuntime.
      const schedulingNodes = toSchedulingNodes(nodes)
      const config = parseWorkflowConfig((yield* store.getWorkflow(dagID))?.config ?? "")
      const maxConcurrency = Math.max(1, config?.max_concurrency ?? DEFAULT_WORKFLOW_CONFIG.maxConcurrency)
      const runtime = new WorkflowRuntime(schedulingNodes, maxConcurrency)
      const ready = runtime.getReadyNodes()
      if (ready.length === 0) return { status: "no_ready_nodes" as const }
      const nodeID = ready.slice().sort()[0]
      yield* events.publish(DagEvent.WorkflowStepped, { dagID: dagID as ID, nodeID: nodeID as never, timestamp: yield* DateTime.now })
      return { status: "stepping" as const, nodeID }
    })
    // Publish terminal node events for any non-terminal nodes so the read
    // model stays consistent after workflow termination.  Running nodes get
    // NodeFailed (or NodeSkipped when failRunning=false); pending/queued
    // nodes always get NodeSkipped.  The projector's status guards make this
    // safe against races — a node that transitioned between the read and the
    // publish is silently left at its current status.
    const terminateNonTerminalNodes = Effect.fnUntraced(function* (dagID: string, skipReason: "agent_complete" | "workflow_cancelled" | "workflow_failed", failReason: string, failRunning: boolean) {
      const nodes = yield* store.getNodes(dagID)
      for (const node of nodes) {
        if (isNodeTerminalStatus(node.status as NodeStatus)) continue
        const ts = yield* DateTime.now
        if (failRunning && node.status === "running") {
          yield* events.publish(DagEvent.NodeFailed, {
            dagID: dagID as ID,
            nodeID: node.id as never,
            reason: failReason,
            trigger: "exec_failed" as never,
            timestamp: ts,
          })
        } else {
          yield* events.publish(DagEvent.NodeSkipped, {
            dagID: dagID as ID,
            nodeID: node.id as never,
            reason: skipReason,
            timestamp: ts,
          })
        }
      }
    })

    const cancel = Effect.fn("Dag.cancel")(function* (dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.CANCELLED)
      yield* events.publish(DagEvent.WorkflowCancelled, { dagID: dagID as ID, timestamp: yield* DateTime.now })
      yield* terminateNonTerminalNodes(dagID, "workflow_cancelled", "workflow_cancelled", false)
    })
    const complete = Effect.fn("Dag.complete")(function* (dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.COMPLETED)
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      const config = workflow ? parseWorkflowConfig(workflow.config) : undefined
      const unresolvedReviews = config
        ? unresolvedReviewOutcomes(config, yield* store.getNodes(dagID))
        : []
      if (unresolvedReviews.length > 0) yield* Effect.fail(new ReviewGateError(dagID, unresolvedReviews))
      yield* terminateNonTerminalNodes(dagID, "agent_complete", "", false)
      yield* events.publish(DagEvent.WorkflowCompleted, { dagID: dagID as ID, durationMs: 0 as never, timestamp: yield* DateTime.now })
    })

    const fail = Effect.fn("Dag.fail")(function* (dagID: string, reason: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.FAILED)
      yield* events.publish(DagEvent.WorkflowFailed, { dagID: dagID as ID, reason, failedNodes: [] as never, timestamp: yield* DateTime.now })
      yield* terminateNonTerminalNodes(dagID, "workflow_failed", reason, true)
    })

    const _replan = Effect.fn("Dag._replan")(function* (
      dagID: string,
      fragment: { nodes: NodeConfig[] },
      reopenCompleted = false,
    ) {
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      if (
        isWorkflowTerminalStatus(workflow.status as WorkflowStatus)
        && !(reopenCompleted && workflow.status === WorkflowStatus.COMPLETED)
      ) {
        return yield* Effect.fail(new TerminalViolationError(dagID, workflow.status, "replan"))
      }
      const wfConfig = parseWorkflowConfig(workflow.config)
      const defaults = normalizeNodeDefaults(wfConfig?.node_defaults)
      const normalizedFragment = { nodes: fragment.nodes.map((node) => normalizeNodeConfig(node, defaults)) }
      const nodes = yield* store.getNodes(dagID)
      const plan = planReplan(
        { nodes: nodes.map((n) => ({ id: n.id, status: n.status as never, depends_on: n.dependsOn })) },
        { nodes: normalizedFragment.nodes.map((n) => ({ id: n.id, depends_on: n.depends_on, restart: n.restart, cancel: n.cancel })) },
      )
      if (plan.errors.length > 0) return yield* Effect.fail(new Error(`Replan rejected: ${plan.errors.join("; ")}`))

      // Fragment nodes that will actually (re)run must satisfy the same
      // condition-reference rule as create. Terminal nodes in the fragment are
      // ignored by the plan and keep their immutable definitions; cancelled
      // nodes never evaluate a condition again.
      const nodeStatusById = new Map(nodes.map((n) => [n.id, n.status]))
      const conditionErrors = conditionReferenceErrors(
        normalizedFragment.nodes.filter((n) => {
          if (n.cancel) return false
          const status = nodeStatusById.get(n.id)
          return status === undefined || !isNodeTerminalStatus(status as NodeStatus)
        }),
      )
      if (conditionErrors.length > 0) {
        return yield* Effect.fail(new Error(`Replan rejected: ${conditionErrors.join("; ")}`))
      }

      const maxReplanAttempts = wfConfig?.max_node_replan_attempts ?? DEFAULT_WORKFLOW_CONFIG.maxNodeReplanAttempts
      const maxTotalNodes = wfConfig?.max_total_nodes ?? DEFAULT_WORKFLOW_CONFIG.maxTotalNodes

      // Enforce total node ceiling BEFORE any event publication so a rejected
      // replan leaves no durable side effects. Count ALL nodes ever registered
      // (cumulative lifetime) — terminal nodes still count toward the cap.
      if (nodes.length + plan.add.length > maxTotalNodes) {
        return yield* Effect.fail(new Error(`Total node ceiling exceeded: ${nodes.length} existing + ${plan.add.length} new > ${maxTotalNodes} max`))
      }

      if (wfConfig) {
        const reviewLifecycle = validateReviewLifecycle(
          computeMergedConfig(wfConfig, normalizedFragment, plan),
        )
        if (!reviewLifecycle.valid) {
          return yield* Effect.fail(new Error(
            `Invalid review lifecycle: ${reviewLifecycle.errors.join("; ")}`,
          ))
        }
        for (const warning of reviewLifecycle.warnings) {
          yield* Effect.logWarning("DAG review lifecycle diagnostic", { warning })
        }
      }

      const nodeById = new Map(nodes.map((n) => [n.id, n]))
      const ceilingBreached: string[] = []
      for (const id of plan.restart) {
        const existing = nodeById.get(id)
        if (existing && existing.replanAttempts >= maxReplanAttempts) {
          yield* nodeFailed(dagID, id, "replan attempt ceiling exceeded", "exec_failed").pipe(Effect.ignore)
          ceilingBreached.push(id)
        }
      }
      const effectiveRestart = plan.restart.filter((id) => !ceilingBreached.includes(id))

      const fragmentById = new Map(normalizedFragment.nodes.map((n) => [n.id, n]))
      for (const id of plan.add) {
        const node = fragmentById.get(id)!
        yield* events.publish(DagEvent.NodeRegistered, {
          dagID: dagID as ID,
          nodeID: id as never,
          name: node.name,
          workerType: node.worker_type,
          dependsOn: node.depends_on.map((d) => d as never),
          required: node.required,
          model: node.model as never,
          timestamp: yield* DateTime.now,
        })
      }
      // Replaced nodes: re-publish NodeRegistered so the projector upserts the
      // new definition (worker_type, model, depends_on) into the read-model row.
      for (const id of plan.replace) {
        const node = fragmentById.get(id)
        if (!node) continue
        yield* events.publish(DagEvent.NodeRegistered, {
          dagID: dagID as ID,
          nodeID: id as never,
          name: node.name,
          workerType: node.worker_type,
          dependsOn: node.depends_on.map((d) => d as never),
          required: node.required,
          model: node.model as never,
          timestamp: yield* DateTime.now,
        })
      }
      for (const id of plan.cancel) {
        yield* events.publish(DagEvent.NodeCancelled, {
          dagID: dagID as ID,
          nodeID: id as never,
          timestamp: yield* DateTime.now,
        })
      }
      for (const id of effectiveRestart) {
        yield* events.publish(DagEvent.NodeRestarted, {
          dagID: dagID as ID,
          nodeID: id as never,
          childSessionID: (nodeById.get(id)?.childSessionId ?? "") as never,
          timestamp: yield* DateTime.now,
        })
      }

      // #6: build effective plan that excludes ceiling-breached restarts
      const effectivePlan = { ...plan, restart: effectiveRestart }

      // Persist the merged config using the effective plan (without ceiling-breached restarts)
      if (wfConfig) {
        const mergedConfig = computeMergedConfig(wfConfig, normalizedFragment, effectivePlan)
        yield* events.publish(DagEvent.WorkflowConfigUpdated, {
          dagID: dagID as ID,
          config: JSON.stringify(mergedConfig),
          timestamp: yield* DateTime.now,
        })
      } else {
        yield* Effect.logWarning("Dag.replan: failed to parse current config JSON — node definitions from fragment may be lost", { dagID })
      }

      // #7: max_total_nodes check is non-atomic (read-then-publish). This is
      // acceptable because the ceiling is a fail-safe, not a correctness
      // invariant — concurrent replans slightly exceeding the limit is better
      // than serializing all replans. The projector's INSERT ON CONFLICT
      // ensures no duplicate node IDs.
      yield* events.publish(DagEvent.WorkflowReplanned, {
        dagID: dagID as ID,
        added: effectivePlan.add.length as never,
        removed: effectivePlan.cancel.length as never,
        replaced: effectivePlan.replace.length as never,
        restarted: effectivePlan.restart.length as never,
        timestamp: yield* DateTime.now,
      })
      return { cancel: effectivePlan.cancel, restart: effectivePlan.restart, replace: effectivePlan.replace, add: effectivePlan.add, ignore: effectivePlan.ignore }
    })

    const _extend = Effect.fn("Dag._extend")(function* (dagID: string, newNodes: NodeConfig[]) {
      const wf = yield* store.getWorkflow(dagID)
      if (!wf) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      const nodes = yield* store.getNodes(dagID)
      const config = parseWorkflowConfig(wf.config)
      const cfgById = new Map((config?.nodes ?? []).map((n) => [n.id, n]))
      const newIds = new Set(newNodes.map((n) => n.id))
      // extend is additive: carry forward pending/queued/paused nodes (with their
      // existing config definition) so replan treats them as "replace" (preserved)
      // rather than "supersede" (cancelled). Running nodes are intentionally
      // excluded — a running node absent from the fragment is already kept
      // unchanged by replan, so there is nothing to carry forward. Terminal
      // nodes are immutable and need no preservation.
      const toPreserve = nodes.filter((n) => !newIds.has(n.id) && (n.status === NodeStatus.PENDING || n.status === NodeStatus.QUEUED || n.status === NodeStatus.PAUSED))
      if (toPreserve.length > 0 && !config) {
        return yield* Effect.fail(new Error(`Cannot extend: workflow config is unparseable — would silently cancel ${toPreserve.length} pending node(s)`))
      }
      const preserved = toPreserve
        .map((n) => cfgById.get(n.id))
        .filter((n): n is NodeConfig => n !== undefined)
      const configuredNodes = config?.nodes ?? []
      const hasReportingLeafCheckpoint = nodes.some(
        (node) =>
          node.status === NodeStatus.COMPLETED
          && node.wakeEligible
          && configuredNodes.some((candidate) => candidate.id === node.id)
          && !configuredNodes.some((candidate) => candidate.depends_on.includes(node.id)),
      )
      const reopenCompleted =
        wf.status === WorkflowStatus.COMPLETED
        && newNodes.some((node) => !nodes.some((existing) => existing.id === node.id))
        && hasReportingLeafCheckpoint
        && !nodes.some((node) => node.errorReason === "agent_complete")
      // A terminal atomic wake may ask the parent to add the next bounded wave.
      // Keep the exception private to naturally completed additive extension;
      // an early control(complete) leaves an agent_complete marker and remains
      // terminal, as do public replan and non-additive terminal mutations.
      // Internal call to _replan — shares the caller's lock holding period,
      // does NOT re-acquire the per-workflow lock or go through Service.of.
      return yield* _replan(dagID, { nodes: [...preserved, ...newNodes] }, reopenCompleted)
    })

    const nodeQueued = Effect.fn("Dag.nodeQueued")(function* (dagID: string, nodeID: string, deadlineMs?: number) {
      yield* guardNode(dagID, nodeID, NodeStatus.QUEUED)
      yield* events.publish(DagEvent.NodeQueued, { dagID: dagID as ID, nodeID: nodeID as never, deadlineMs, timestamp: yield* DateTime.now })
    })
    const nodeStarted = Effect.fn("Dag.nodeStarted")(function* (dagID: string, nodeID: string, childSessionID: string, deadlineMs?: number, wakeEligible?: boolean) {
      yield* guardNode(dagID, nodeID, NodeStatus.RUNNING)
      yield* events.publish(DagEvent.NodeStarted, { dagID: dagID as ID, nodeID: nodeID as never, childSessionID: childSessionID as never, deadlineMs, wakeEligible, timestamp: yield* DateTime.now })
    })
    const nodeCompleted = Effect.fn("Dag.nodeCompleted")(function* (dagID: string, nodeID: string, output: unknown) {
      yield* guardNode(dagID, nodeID, NodeStatus.COMPLETED)
      yield* events.publish(DagEvent.NodeCompleted, { dagID: dagID as ID, nodeID: nodeID as never, output, durationMs: 0 as never, timestamp: yield* DateTime.now })
    })
    const nodeFailed = Effect.fn("Dag.nodeFailed")(function* (dagID: string, nodeID: string, reason: string, trigger: string) {
      yield* guardNode(dagID, nodeID, NodeStatus.FAILED)
      yield* events.publish(DagEvent.NodeFailed, { dagID: dagID as ID, nodeID: nodeID as never, reason, trigger: trigger as never, timestamp: yield* DateTime.now })
    })
    const nodeSkipped = Effect.fn("Dag.nodeSkipped")(function* (dagID: string, nodeID: string, reason: string) {
      yield* guardNode(dagID, nodeID, NodeStatus.SKIPPED)
      yield* events.publish(DagEvent.NodeSkipped, { dagID: dagID as ID, nodeID: nodeID as never, reason: reason as never, timestamp: yield* DateTime.now })
    })
    const nodeCancelled = Effect.fn("Dag.nodeCancelled")(function* (dagID: string, nodeID: string) {
      // Cancellation is valid from any non-terminal status; no single target
      // NodeStatus is a legal transition from all of pending/queued/running/paused
      // (e.g. PAUSED -> SKIPPED is not in the table), so guard on terminality.
      yield* guardWorkflowNotTerminal(dagID, "cancelled")
      const node = yield* store.getNode(dagID, nodeID).pipe(Effect.orDie)
      if (!node) return yield* Effect.fail(new Error(`Node not found: ${nodeID}`))
      if (isNodeTerminalStatus(node.status as NodeStatus)) {
        return yield* Effect.fail(new TerminalViolationError(nodeID, node.status, "cancelled"))
      }
      yield* events.publish(DagEvent.NodeCancelled, {
        dagID: dagID as ID,
        nodeID: nodeID as never,
        timestamp: yield* DateTime.now,
      })
    })
    const nodeRestarted = Effect.fn("Dag.nodeRestarted")(function* (dagID: string, nodeID: string, childSessionID: string) {
      yield* guardNode(dagID, nodeID, NodeStatus.PENDING)
      yield* events.publish(DagEvent.NodeRestarted, { dagID: dagID as ID, nodeID: nodeID as never, childSessionID: childSessionID as never, timestamp: yield* DateTime.now })
    })

    return Service.of({
      create,
      store,
      pause: (dagID) => withWorkflowLock(dagID)(pause(dagID)),
      resume: (dagID) => withWorkflowLock(dagID)(resume(dagID)),
      step: (dagID) => withWorkflowLock(dagID)(step(dagID)),
      cancel: (dagID) => withWorkflowLock(dagID)(cancel(dagID)),
      complete: (dagID) => withWorkflowLock(dagID)(complete(dagID)),
      fail: (dagID, reason) => withWorkflowLock(dagID)(fail(dagID, reason)),
      replan: (dagID, fragment) => withWorkflowLock(dagID)(_replan(dagID, fragment)),
      extend: (dagID, nodes) => withWorkflowLock(dagID)(_extend(dagID, nodes)),
      nodeQueued: (dagID, nodeID, deadlineMs) => withWorkflowLock(dagID)(nodeQueued(dagID, nodeID, deadlineMs)),
      nodeStarted: (dagID, nodeID, childSessionID, deadlineMs, wakeEligible) =>
        withWorkflowLock(dagID)(nodeStarted(dagID, nodeID, childSessionID, deadlineMs, wakeEligible)),
      nodeCompleted: (dagID, nodeID, output) => withWorkflowLock(dagID)(nodeCompleted(dagID, nodeID, output)),
      nodeFailed: (dagID, nodeID, reason, trigger) => withWorkflowLock(dagID)(nodeFailed(dagID, nodeID, reason, trigger)),
      nodeSkipped: (dagID, nodeID, reason) => withWorkflowLock(dagID)(nodeSkipped(dagID, nodeID, reason)),
      nodeCancelled: (dagID, nodeID) => withWorkflowLock(dagID)(nodeCancelled(dagID, nodeID)),
      nodeRestarted: (dagID, nodeID, childSessionID) => withWorkflowLock(dagID)(nodeRestarted(dagID, nodeID, childSessionID)),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(DagProjector.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, DagStore.node, DagProjector.node])
