/**
 * DAG scheduling core — status enums, transition tables, and error types.
 *
 * Pure: zero Effect/DB/I/O imports. This is the single source of truth for the
 * iron-law state machine (validated transitions, terminal irreversibility)
 * that the runtime layer enforces around every status change.
 *
 * Ported from the dag-iron-laws branch's state-machine/{types,errors}.ts with
 * shadow-node / old-event-union / old-state.json cruft dropped (sub-DAG nesting
 * is deferred; EventV2 events are defined separately in schema/dag-event.ts;
 * read-model tables replace state.json).
 */

// ============================================================================
// Status enums
// ============================================================================

export enum WorkflowStatus {
  PENDING = "pending",
  RUNNING = "running",
  PAUSED = "paused",
  STEPPING = "stepping",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
  ARCHIVED = "archived",
}

export enum NodeStatus {
  PENDING = "pending",
  QUEUED = "queued",
  RUNNING = "running",
  PAUSED = "paused",
  COMPLETED = "completed",
  FAILED = "failed",
  ABORTED = "aborted",
  SKIPPED = "skipped",
}

/** Why a node entered FAILED — recorded for diagnostics and replan decisions. */
export enum FallbackTrigger {
  EXEC_FAILED = "exec_failed",
  PUSH_EXHAUSTED = "push_exhausted",
  VERDICT_FAIL = "verdict_fail",
  TIMEOUT = "timeout",
}

/** Why a node entered SKIPPED — distinguishes condition-skip from agent-abandon (D13). */
export enum SkipReason {
  /** Node's `condition` evaluated false. Non-violation even if required. */
  CONDITION_FALSE = "condition_false",
  /** Agent called `control(complete)` early; remaining nodes abandoned. Non-violation. */
  AGENT_COMPLETE = "agent_complete",
  /** An upstream dependency was cancelled/failed, cascading failure to this node. */
  ORPHAN_CASCADE = "orphan_cascade",
}

// ============================================================================
// Error codes + base error
// ============================================================================

export enum ErrorCode {
  INVALID_TRANSITION = "INVALID_TRANSITION",
  TERMINAL_VIOLATION = "TERMINAL_VIOLATION",
  STATE_MACHINE_VIOLATION = "STATE_MACHINE_VIOLATION",
  EVENT_NOT_BROADCAST = "EVENT_NOT_BROADCAST",
  STATE_NOT_PERSISTED = "STATE_NOT_PERSISTED",
  MISSING_REQUIRED_NODE = "MISSING_REQUIRED_NODE",
  DUPLICATE_NODE_NAME = "DUPLICATE_NODE_NAME",
  DEPENDENCY_NOT_MET = "DEPENDENCY_NOT_MET",
}

export class DagCoreError extends Error {
  readonly code: ErrorCode
  readonly context: Record<string, unknown>
  readonly timestamp: Date

  constructor(code: ErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message)
    this.name = "DagCoreError"
    this.code = code
    this.context = context
    this.timestamp = new Date()
  }
}

export class InvalidTransitionError extends DagCoreError {
  constructor(entityId: string, fromStatus: string, toStatus: string) {
    super(
      ErrorCode.INVALID_TRANSITION,
      `Invalid transition: ${entityId} (${fromStatus} -> ${toStatus})`,
      { entityId, fromStatus, toStatus },
    )
    this.name = "InvalidTransitionError"
  }
}

export class TerminalViolationError extends DagCoreError {
  constructor(entityId: string, terminalStatus: string, attemptedStatus: string) {
    super(
      ErrorCode.TERMINAL_VIOLATION,
      `Cannot transition from terminal state: ${entityId} (${terminalStatus} -> ${attemptedStatus})`,
      { entityId, terminalStatus, attemptedStatus },
    )
    this.name = "TerminalViolationError"
  }
}

export class StateNotPersistedError extends DagCoreError {
  constructor(workflowId: string, reason?: string) {
    super(
      ErrorCode.STATE_NOT_PERSISTED,
      `Workflow state not persisted for ${workflowId}${reason ? `: ${reason}` : ""}`,
      { workflowId, reason },
    )
    this.name = "StateNotPersistedError"
  }
}

// ============================================================================
// Iron-law enforcement: terminal predicates + transition tables
// ============================================================================

/** Iron law #2: terminal statuses are irreversible. */
export function isWorkflowTerminalStatus(status: WorkflowStatus): boolean {
  return (
    status === WorkflowStatus.COMPLETED ||
    status === WorkflowStatus.FAILED ||
    status === WorkflowStatus.CANCELLED ||
    status === WorkflowStatus.ARCHIVED
  )
}

/** Iron law #2: terminal statuses are irreversible. */
export function isNodeTerminalStatus(status: NodeStatus): boolean {
  return (
    status === NodeStatus.COMPLETED ||
    status === NodeStatus.FAILED ||
    status === NodeStatus.ABORTED ||
    status === NodeStatus.SKIPPED
  )
}

/**
 * Iron law #1: state changes only through validated transitions.
 *
 * Returns the list of statuses the node MAY move to from its current one.
 * An empty array means the node is terminal (no further transitions) —
 * callers MUST treat attempts to transition further as TerminalViolationError.
 *
 * The `restart` path (running -> paused -> pending -> running) is encoded here:
 * PAUSED returns [RUNNING] and RUNNING returns [PENDING]. All terminal states
 * (COMPLETED/FAILED/ABORTED/SKIPPED) return [] — restarts never originate from
 * a terminal node; the projector's NodeRestarted resets the row to PENDING.
 */
export function getValidNextNodeStatuses(currentStatus: NodeStatus): NodeStatus[] {
  switch (currentStatus) {
    case NodeStatus.PENDING:
      return [NodeStatus.QUEUED, NodeStatus.RUNNING, NodeStatus.SKIPPED, NodeStatus.FAILED]
    case NodeStatus.QUEUED:
      return [NodeStatus.RUNNING, NodeStatus.SKIPPED]
    case NodeStatus.RUNNING:
      return [NodeStatus.COMPLETED, NodeStatus.FAILED, NodeStatus.PAUSED, NodeStatus.PENDING, NodeStatus.SKIPPED]
    case NodeStatus.PAUSED:
      return [NodeStatus.RUNNING]
    case NodeStatus.COMPLETED:
    case NodeStatus.FAILED:
    case NodeStatus.ABORTED:
    case NodeStatus.SKIPPED:
      return []
    default:
      return []
  }
}

/**
 * Iron law #1: state changes only through validated transitions.
 *
 * Returns the list of statuses the workflow MAY move to from its current one.
 */
export function getValidNextWorkflowStatuses(currentStatus: WorkflowStatus): WorkflowStatus[] {
  switch (currentStatus) {
    case WorkflowStatus.PENDING:
      return [WorkflowStatus.RUNNING]
    case WorkflowStatus.RUNNING:
      return [WorkflowStatus.PAUSED, WorkflowStatus.STEPPING, WorkflowStatus.COMPLETED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED]
    case WorkflowStatus.STEPPING:
      return [WorkflowStatus.RUNNING, WorkflowStatus.PAUSED, WorkflowStatus.COMPLETED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED]
    case WorkflowStatus.PAUSED:
      return [WorkflowStatus.RUNNING, WorkflowStatus.CANCELLED]
    case WorkflowStatus.COMPLETED:
    case WorkflowStatus.FAILED:
    case WorkflowStatus.CANCELLED:
      return [WorkflowStatus.ARCHIVED]
    case WorkflowStatus.ARCHIVED:
      return []
    default:
      return []
  }
}

/**
 * Iron law #1 helper: assert a transition is legal, throwing if not.
 * Used by the runtime layer before persisting any status change.
 */
export function assertValidNodeTransition(nodeId: string, from: NodeStatus, to: NodeStatus): void {
  if (isNodeTerminalStatus(from)) {
    throw new TerminalViolationError(nodeId, from, to)
  }
  if (!getValidNextNodeStatuses(from).includes(to)) {
    throw new InvalidTransitionError(nodeId, from, to)
  }
}

export function assertValidWorkflowTransition(workflowId: string, from: WorkflowStatus, to: WorkflowStatus): void {
  if (getValidNextWorkflowStatuses(from).includes(to)) return
  if (isWorkflowTerminalStatus(from)) {
    throw new TerminalViolationError(workflowId, from, to)
  }
  throw new InvalidTransitionError(workflowId, from, to)
}
