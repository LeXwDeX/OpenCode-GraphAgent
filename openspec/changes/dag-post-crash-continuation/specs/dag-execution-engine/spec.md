## ADDED Requirements

### Requirement: DAG node execution ownership is process-local

A node SHALL be considered actively executing only while the current process owns its tracked node execution fiber. Persisted node status, child Session identity, and a non-terminal child Session projection SHALL NOT by themselves constitute execution ownership after a process restart.

#### Scenario: persisted running status does not restore execution ownership

- **WHEN** a process restarts with a node persisted as `running`
- **AND** the new DagLoop has no tracked fiber for that node
- **THEN** the system SHALL treat the previous execution attempt as having lost ownership
- **AND** SHALL reconcile it through `dag-scheduler-recovery`

#### Scenario: current-process fiber proves active execution

- **WHEN** `spawnReady` creates a node execution fiber in the current process
- **AND** stores it in `WorkflowEntry.fibers`
- **THEN** the node MAY be treated as actively making progress until that fiber terminates or is interrupted

### Requirement: Crash recovery does not retry provider work implicitly

The DAG runtime MUST NOT automatically retry or continue provider/tool execution merely because a recovered child Session is non-terminal. A new execution attempt SHALL require an explicit scheduling transition produced by normal workflow control, such as replan/restart, after the lost attempt has reached a DAG terminal state.

#### Scenario: recovery does not invoke provider continuation

- **WHEN** recovery finds a child Session classified as `active` or `unknown`
- **THEN** it SHALL NOT call `SessionExecution.wake`, `SessionPrompt.prompt`, or `spawnNode` for that lost attempt
- **AND** SHALL terminalize the attempt according to `dag-scheduler-recovery`

#### Scenario: explicit replan can create a new attempt

- **WHEN** the parent orchestrator observes a recovery failure
- **AND** explicitly replans or restarts the node through the workflow control surface
- **THEN** the normal `NodeRestarted` and scheduling path MAY create a new child Session and execution fiber

## MODIFIED Requirements

### Requirement: Crash-recovery re-attachment inherits the node's timeout

A node's resolved timeout deadline (absolute `spawnedAt + timeout_ms`) SHALL be persisted as durable node state. Crash recovery SHALL use `reconcileWorkflow` as a one-time startup scan to classify every node left in `running`.

If the child Session already completed or failed, recovery SHALL publish the corresponding DAG terminal event. If the child Session remains `active` or `unknown`, recovery SHALL recognize that the crashed process's timeout and prompt fibers no longer exist. It SHALL best-effort cancel the old child Session and terminalize the node: expired deadlines use `NodeFailed(timeout)`; future or unset deadlines use `NodeFailed(exec_failed)` with an execution-ownership-loss reason.

Recovery SHALL NOT install a persistent polling watcher and SHALL NOT retry provider work implicitly.

#### Scenario: recovered node with completed child session

- **WHEN** a node is recovered in `running` after restart
- **AND** its child Session has completed
- **THEN** `reconcileWorkflow` SHALL publish `NodeCompleted`, or `NodeFailed(verdict_fail)` when its structured-output contract is unsatisfied

#### Scenario: recovered node with failed child session

- **WHEN** a node is recovered in `running` after restart
- **AND** its child Session has failed
- **THEN** `reconcileWorkflow` SHALL publish `NodeFailed(exec_failed)`

#### Scenario: recovered node with active child session and expired deadline

- **WHEN** a recovered node's child Session is `active` or `unknown`
- **AND** its persisted deadline has expired
- **THEN** recovery SHALL best-effort cancel the child Session
- **AND** SHALL publish `NodeFailed(timeout)`

#### Scenario: recovered node with active child session and future or absent deadline

- **WHEN** a recovered node's child Session is `active` or `unknown`
- **AND** its deadline is in the future or absent
- **THEN** recovery SHALL best-effort cancel the child Session
- **AND** SHALL publish `NodeFailed(exec_failed)` with an execution-ownership-loss reason
- **AND** SHALL NOT leave the node in `running`
