## MODIFIED Requirements

### Requirement: No double-spawn for still-live child sessions

The rehydrated DagLoop MUST NOT spawn replacement child sessions implicitly for nodes whose execution attempt belonged to the crashed process. A persisted child Session status of `active` or `unknown` SHALL NOT be treated as proof that the current process owns an execution fiber.

For every recovered node in `running`, `reconcileWorkflow` SHALL inspect the child Session once. If the Session has already completed or failed, it SHALL publish the corresponding DAG terminal event. If the Session remains `active` or `unknown`, recovery SHALL best-effort cancel that child Session and publish `NodeFailed` for the lost execution attempt. Recovery SHALL NOT call `spawnNode`, reset the node to `pending`, invoke `SessionExecution.wake`, or otherwise retry provider/tool execution implicitly.

A child session with zero messages MUST be classified as `unknown`. Both `active` and `unknown` mean that the durable Session projection is non-terminal; neither state restores process-local DAG execution ownership after restart.

#### Scenario: active child session is terminalized without replacement spawn

- **WHEN** a workflow is recovered with a `running` node whose child Session is classified `active`
- **AND** no current-process fiber owns that node
- **THEN** recovery SHALL best-effort cancel the child Session
- **AND** SHALL publish `NodeFailed` with trigger `exec_failed` and a reason indicating execution ownership was lost on recovery
- **AND** SHALL NOT spawn a replacement child Session

#### Scenario: unknown child session is terminalized without replacement spawn

- **WHEN** a workflow is recovered with a `running` node whose child Session is classified `unknown`
- **THEN** recovery SHALL best-effort cancel the child Session
- **AND** SHALL publish `NodeFailed` for the lost execution attempt
- **AND** SHALL NOT leave the node in `running`

#### Scenario: completed child session is projected instead of failed

- **WHEN** `reconcileWorkflow` finds a `running` node whose child Session completed before the crash
- **THEN** recovery SHALL publish `NodeCompleted` when its output contract is satisfied
- **AND** SHALL publish `NodeFailed` with trigger `verdict_fail` when an output schema exists but no valid captured output exists

#### Scenario: zero-message child session is not adopted

- **WHEN** `reconcileWorkflow` checks a running node's child Session and the Session has zero messages
- **THEN** the Session SHALL be classified as `unknown`
- **AND** recovery SHALL fail the lost execution attempt rather than adopting or restarting it

### Requirement: Recovered running nodes are bounded by deadline re-enforcement

When `reconcileWorkflow()` encounters a node left in `running` after a crash, it MUST compare the current time with persisted `deadline_ms` before classifying execution ownership loss. An expired deadline SHALL produce `NodeFailed` with reason `"deadline exceeded on recovery"` and trigger `"timeout"`.

A future or unset deadline SHALL NOT authorize recovery to leave the node `running`, because the timeout fiber died with the crashed process. If the child Session is still `active` or `unknown`, recovery SHALL best-effort cancel it and publish `NodeFailed` with trigger `"exec_failed"` and reason indicating execution ownership loss.

#### Scenario: recovered node past its deadline fails as timeout

- **WHEN** `reconcileWorkflow()` finds a `running` node whose `deadline_ms` is earlier than the recovery time
- **AND** its child Session is `active` or `unknown`
- **THEN** recovery SHALL best-effort cancel the child Session
- **AND** SHALL publish `NodeFailed` with reason `"deadline exceeded on recovery"` and trigger `"timeout"`

#### Scenario: recovered node before its deadline fails as ownership loss

- **WHEN** `reconcileWorkflow()` finds a `running` node whose deadline is in the future
- **AND** its child Session is `active` or `unknown`
- **THEN** recovery SHALL NOT wait for the future deadline
- **AND** SHALL best-effort cancel the child Session
- **AND** SHALL publish `NodeFailed` with trigger `"exec_failed"` and a reason indicating execution ownership was lost

#### Scenario: recovered node with no deadline cannot remain running

- **WHEN** `reconcileWorkflow()` finds a `running` node with no persisted deadline
- **AND** its child Session is `active` or `unknown`
- **THEN** recovery SHALL best-effort cancel the child Session
- **AND** SHALL publish `NodeFailed`
- **AND** SHALL NOT leave the node indefinitely in `running`

## REMOVED Requirements

### Requirement: The orchestrator_unresponsive safety net remains reachable for recovered workflows

**Reason**: Recovery no longer leaves nodes in `running` without a current-process execution fiber. The old requirement attempted to bound an invalid intermediate state through the parent wake safety net, but no node-result wake is guaranteed to exist for an execution that never reaches a DAG terminal event.

**Migration**: Recovered-running nodes are now terminalized during reconciliation. Their normal `NodeFailed` projection, dependency cascade, workflow terminalization, and durable wake eligibility replace the orphan-specific `orchestrator_unresponsive` fallback.
