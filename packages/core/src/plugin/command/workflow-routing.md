# Workflow Orchestration

In the user-facing parent session, use this tool proactively when one user
objective needs staged, parallel, quality-gated, or adaptive execution. A slash
command is not required. A DAG child session executes its assigned block and
must not recursively route that assignment into another workflow.

## Execution Mode Selection

- Use direct execution for conversation, a small read-only lookup, or one or
  two isolated utility scripts outside a project-level change.
- Use one `task` subagent for one independent non-trivial leaf assignment.
- Use one `workflow` DAG for project-level source or test changes (even when
  only one project file is expected), work that crosses module boundaries,
  product/architecture planning that needs repository exploration, or any
  staged/parallel/gated/adaptive objective.

Related work for one objective belongs in one live workflow. The parent
conversation owns user decisions, scope, checkpoints, workflow control, and
the final synthesis. Child nodes own executable leaf work. Explicit requests
for “single agent”, “do not use DAG”, or direct work disable proactive DAG
selection. Read-only scope changes what nodes may do; it does not by itself
disable a useful exploration or review DAG.

For a project-level route, load the `orchestration-router` skill before
constructing the graph. It selects the smallest useful sequence of composable
blocks and defines the one-confirmation decision checkpoint. Do not place user
questioning inside a child node.

## Progressive guidance

Load details only when needed:

- **guide** without `topic`: compact topic index.
- **guide** `topic=blocks`: composable block schema and examples.
- **guide** `topic=interface`: low-level node fields and tool semantics.
- **guide** `topic=policy`: admission, gates, recovery, and bounded repair.
- **guide** `topic=patterns`: larger domain playbooks.

## Actions

- **start** creates one workflow from exactly one inline `spec` or saved
  `spec_path`.
- **extend** adds nodes or blocks to the same objective.
- **status** reads durable state when the user asks or before a control
  decision; it is not a waiting mechanism.
- **control** pauses, resumes, cancels, replans, steps, or completes a workflow.
- **list** shows saved workflow specs and their resolution scope.
- **read** returns one saved spec so the parent can retarget it before start.

Prefer high-level `blocks` for a fresh one-off flow. Use low-level `nodes` when
the task needs custom bindings, conditions, output schemas, or review metadata.
Never provide both. Reusable saved YAML remains valid and may use either form.
When a saved route is generic, call **read**, replace its objective and
block-specific instructions with the confirmed request, then pass the result
as an inline **start** spec. Start by `spec_path` only when the saved target
already matches exactly.

The workflow runs asynchronously and wakes the parent at actionable reporting
nodes or terminal state. Do not poll, sleep, or loop merely to wait. Never
claim a workflow started unless **start** returned its exact workflow ID.
