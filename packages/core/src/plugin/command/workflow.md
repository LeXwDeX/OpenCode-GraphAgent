<!--
  Shared workflow-tool guidance. The /dag-auto command prepends its routing
  contract, while the workflow tool uses this neutral reference directly.
-->

# Workflow Orchestration

The `workflow` tool orchestrates dependency-graph multi-agent workflows. Each
node runs as a real child session with its own agent and tools. The resident
Orchestration Router owns execution-mode and saved-reference selection; this
guide owns the YAML/tool interface after a workflow has been selected.

Compile every graph under the Tiered Orchestration Doctrine and Depth Ladder in the orchestration policy below: advanced-tier judgment nodes conduct and check, standard-tier nodes carry the volume, and accuracy is bought with breadth (concurrent fan-out) and depth (verdict-gated waves) rather than with a single trusted pass.

## Standard and deep workflow entry

Omitting the top-level start parameter `mode` preserves `standard` behavior. Use `deep` for explicit
deep intent or requests with at least two substantial complexity signals, such
as independent workstreams, cross-domain uncertainty, high blast radius,
conflicting constraints, evidence gathering, or multiple verification
perspectives.

Before `start`, `extend`, `control(replan)`, or `validate`, write the graph to a
`.yaml` or `.yml` file and pass only `spec_path`. A one-off graph may use a
task-local file such as `.opencode/.dag-specs/<name>.yaml`; it does not need to
become a saved library workflow. After a validation failure, edit that same
file and retry with the same path.

Before a deep start, qualify the request interactively in the parent session.
The start spec places `mode: deep`, a versioned `READY` or informed `WAIVED`
admission input, and `config` at the same level. The admission input accepts
only `brief_revision`, `qa_mode`, `verdict`, `brief`, and waiver audit fields
when applicable. Do not copy additional fields from persisted records or tool
responses. Do not put admission QA inside the graph: its answers define the
graph. Use the orchestration policy below for QA modes, round budgets, verdict
recovery, revision invalidation, and waiver audit fields.

A deep start spec has this outer shape:

```yaml
title: Deep review
mode: deep
admission:
  brief_revision: 1
  qa_mode: STANDARD
  verdict: READY
  brief:
    goal: Review the requested implementation
    scope:
      in: [requested modules]
      out: [unrelated modules]
    constraints: [read-only reviewers]
    assumptions: [the working tree is the review target]
    acceptance_criteria: [all material findings are evidence-backed]
    evidence_required: [code references, relevant test results]
    risks: [missed cross-module regressions]
    review_plan: [parallel review, claim verification, final arbitration]
    open_questions: []
    blocking_questions: []
config:
  name: deep-review
  nodes: []
```

## Saved workflows

A `spec_path` with no path separator and no `.yaml`/`.yml` extension is a
**name** resolved against the workflow library instead of the filesystem:

1. `.opencode/workflows/<name>.yaml` — project scope, committed with the repo
2. `<opencode config dir>/workflows/<name>.yaml` — global scope, available in every project
3. bundled builtin templates shipped with the runtime

Project shadows global, and both shadow builtin. Call `workflow(action:
"list")` and use only an exact returned name; never infer one. To inspect a
saved graph without starting it, call
`{ action: "read", spec_path: "<name-returned-by-list>" }`. Retarget its
objective and block instructions in the parent, then write the edited value to
a task-local YAML file. `read` never starts a workflow. A name that resolves
nowhere fails with the searched locations.

## Orchestration Lifecycle

Heavy tasks follow one adaptive workflow whose decisions shape later waves. The lifecycle is the two accuracy axes applied in sequence — breadth to cover the surface, depth to earn the verdict:

1. **Explore + brainstorm** — exploration nodes fan out over the codebase while independent generators propose approaches; a required synthesizer converges them into a design plus architecture inventory.
2. **Design review gate** — an advanced-tier gate node (`report_to_parent: true`, normalized verdict `output_schema`) rules on the design. `required: true` fails the workflow only when the gate node fails to execute or satisfy its output contract; a successful `REVISE` or `REJECT` is a business verdict, not an execution failure. Route the static ACCEPT path through a downstream `condition`, and dispose of a reported non-ACCEPT verdict per the Verdict Disposal Contract.
3. **Parallel execution** — the accepted design decomposes into module-level worker nodes with disjoint write sets, fanning into a required assembler.
4. **Verify + diff review + audit** — production assurance follows `implementation → verification(PASS) → diff review → final gate/audit` with fingerprint echo; `REJECT` routes through corrected implementation and verification before a new diff review. Progress tracking is updated to reflect what shipped.
5. **Expansion decision** — iterate (bounded `control(replan)` of affected nodes), extend (additional parallel nodes in the same workflow), or complete (`control(complete)`). Start a continuation workflow only after the original is terminal and cannot be adapted.

Not every task needs all five phases: a well-specified task may enter at phase 3, a clear design with uncertain scope at phase 2. The lifecycle is a decision tree, not a pipeline. Concrete graph shapes are under Collaboration Patterns below.

## Node inputs and model selection

Every node automatically receives the outputs of its direct `depends_on` nodes:

- The exact dependency ID is the default template variable. A node with `depends_on: [node-a, node-b]` can use `{{node-a}}` and `{{node-b}}` directly.
- The same values are appended to the child prompt as structured context, so a downstream node can aggregate them without interpolation.
- Use `input_mapping` only to rename a variable or select a field. Its direction is **template variable → upstream source**, for example:

```yaml
input_mapping:
  resultA: node-a
  resultB: node-b
  count: node-c.output.count
prompt_template:
  inline: "Summarize {{resultA}}, {{resultB}}, and count={{count}}."
```

Put shared node defaults in the workflow's `config.node_defaults`. Every node
inherits omitted values from this durable workflow config, while an explicit
node value wins:

```yaml
config:
  node_defaults:
    required: false
    report_to_parent: false
    worker_config:
      timeout_ms: 600000
```

The listed node and default fields are exhaustive; workflow YAML has no
model-selection field. Model selection is configuration-owned: critical nodes
(`required: true` and review workers) use
the `advanced` tier in `dag.jsonc`, other nodes use `standard`, then resolution
falls back to the selected agent model and the parent-session model. If no
source provides a model, the workflow tool starts parent-session QA and leaves
the workflow uncreated so the user can configure a model and retry.

## Collaboration Patterns

Four structural patterns cover the common cases. Real workflows often combine
them. Every block below is YAML file content. Save the selected shape, validate
it with `{ action: "validate", spec_path: "<file>.yaml" }`, then start it with
`{ action: "start", spec_path: "<file>.yaml" }`.

### 1. Staged Pipeline with Gate

Sequential phases where each depends on the previous. Insert a gate node between phases to block downstream execution until quality is confirmed.

```yaml
config:
  name: staged-gate
  nodes:
    - id: explore
      name: explore
      worker_type: explore
      depends_on: []
      prompt_template: { id: code-explore, input: { target: "auth module" } }
      required: true

    - id: gate
      name: gate
      worker_type: general
      depends_on: [explore]
      input_mapping:
        findings: explore
      required: true
      report_to_parent: true
      output_schema:
        type: object
        required: [verdict, summary]
        properties:
          verdict:
            type: string
            enum: [ACCEPT, REVISE, REJECT, BLOCKED]
          summary: { type: string }
      prompt_template:
        inline: "Review these findings and submit a structured verdict: {{findings}}"

    - id: implement
      name: implement
      worker_type: build
      depends_on: [gate]
      condition: 'gate.output.verdict == "ACCEPT"'
      prompt_template:
        inline: "Implement based on approved findings."
```

The gate node is `required: true`, so an execution or output-contract failure
cancels the workflow. A successful non-ACCEPT verdict does not fail the node;
the condition prevents `implement` from running, and the reported verdict gives
the parent an actionable replan or stop decision.

### 2. Parallel Fan-out

One preparatory node feeds N independent worker nodes, which fan back into a single assembler.

```yaml
config:
  name: parallel-fan-out
  nodes:
    - id: discover
      name: discover
      worker_type: explore
      depends_on: []
      prompt_template: { inline: "List all packages that need the API migration." }
      required: true

    - id: migrate-auth
      name: migrate-auth
      worker_type: build
      depends_on: [discover]
      prompt_template: { inline: "Migrate the auth package to the new API." }

    - id: migrate-server
      name: migrate-server
      worker_type: build
      depends_on: [discover]
      prompt_template: { inline: "Migrate the server package to the new API." }

    - id: migrate-cli
      name: migrate-cli
      worker_type: build
      depends_on: [discover]
      prompt_template: { inline: "Migrate the CLI package to the new API." }

    - id: assemble
      name: assemble
      worker_type: build
      depends_on: [migrate-auth, migrate-server, migrate-cli]
      prompt_template: { inline: "Run integration tests and assemble a summary." }
```

`migrate-*` nodes execute concurrently (bounded by `max_concurrency`). `assemble` waits until all three complete. Non-required worker nodes that fail do not cancel the workflow — `assemble` still runs and can report which migrations failed.

### 3. Adversarial Review

Multiple reviewer nodes with different perspectives examine the same artifact. A final arbiter synthesizes their verdicts. The arbiter must not be a silent terminal leaf: gate an in-graph continuation node on its verdict (shown below), or dispose of the reported verdict at the wake boundary per the Verdict Disposal Contract.

```yaml
config:
  name: adversarial-review
  nodes:
    - id: implement
      name: implement
      worker_type: build
      depends_on: []
      prompt_template: { id: implement, input: { spec: "Implement the requested change per the task description" } }
      required: true

    - id: review-arch
      name: review-arch
      worker_type: general
      depends_on: [implement]
      prompt_template: { id: review-arch }

    - id: review-logic
      name: review-logic
      worker_type: general
      depends_on: [implement]
      prompt_template: { id: review-logic }

    - id: review-style
      name: review-style
      worker_type: general
      depends_on: [implement]
      prompt_template: { id: review-style }

    - id: arbitrate
      name: arbitrate
      worker_type: general
      depends_on: [review-arch, review-logic, review-style]
      required: true
      report_to_parent: true
      output_schema:
        type: object
        required: [verdict, summary, findings, required_actions]
        properties:
          verdict:
            type: string
            enum: [ACCEPT, REVISE, REJECT, BLOCKED]
          summary: { type: string }
          findings: { type: array }
          required_actions: { type: array }
      prompt_template:
        inline: "Three reviewers produced findings. Submit one structured ACCEPT, REVISE, REJECT, or BLOCKED decision with deduplicated findings and required actions. The parent chooses any workflow control action."

    - id: deep-dive
      name: deep-dive
      worker_type: general
      depends_on: [arbitrate]
      condition: 'arbitrate.output.verdict != "ACCEPT"'
      report_to_parent: true
      prompt_template:
        inline: "The arbiter did not accept. Verify each required action against the actual code and produce a corrected, evidence-backed action plan."
```

Reviewer nodes use the `advanced` tier from `dag.jsonc`. The arbiter is
`required: true` — its execution failure signals
that the artifact could not be confidently accepted, while its successful
business verdict must still be interpreted. On `ACCEPT` the conditioned
`deep-dive` node is skipped and the workflow completes; on any other verdict
it runs with the arbiter's findings as context, so a non-ACCEPT outcome can
never silently terminalize the graph.

### 4. Diverge-Converge (Brainstorm)

Multiple independent generators produce candidate solutions; a converger selects and refines.

```yaml
config:
  name: diverge-converge
  nodes:
    - id: gen-a
      name: gen-a
      worker_type: general
      depends_on: []
      prompt_template:
        inline: "Propose a solution for X using approach: microservices."

    - id: gen-b
      name: gen-b
      worker_type: general
      depends_on: []
      prompt_template:
        inline: "Propose a solution for X using approach: modular monolith."

    - id: gen-c
      name: gen-c
      worker_type: general
      depends_on: []
      prompt_template:
        inline: "Propose a solution for X using approach: event-driven."

    - id: converge
      name: converge
      worker_type: general
      depends_on: [gen-a, gen-b, gen-c]
      required: true
      prompt_template:
        inline: "Three approaches were proposed. Compare trade-offs and select the best fit for the constraints."
```

## Adaptive Replanning

Workflows are not static. After creating a workflow, use `extend` and `control(replan)` to adapt based on observed results:

- **Scale up**: a node reports the work is larger than expected → `extend` with additional parallel nodes to split the load.
- **Cut short**: a node proves the remaining work is unnecessary → `control(complete)` to early-complete and skip pending nodes.
- **Redirect**: a gate or review reveals a wrong direction → `control(pause)` first to freeze scheduling, then `control(replan)` with `restart: true` on the affected nodes and `cancel: true` on their downstream dependents, then `control(resume)`.

Only nodes with `report_to_parent: true` produce intermediate parent
checkpoints, and those reports are delivered at the next actionable wake
boundary. Terminal workflow state also wakes the parent. Do not poll `status`
merely to wait. When a report suggests the task decomposition was wrong, replan
rather than letting the original graph run to completion. Note the terminal
boundary: the runtime's mandatory-action guard only covers workflows that are
still live, so a checkpoint that terminalizes its workflow delivers its
verdict with no runtime enforcement — the Verdict Disposal Contract in the
orchestration policy governs exactly that case (`extend` remains valid after
a reporting leaf naturally completed the graph).

### Escalation: change approach after repeated failures

When the same node or workflow keeps failing — via `orchestrator_unresponsive` (the woken agent took no action), a replan-attempt ceiling rejection, or repeated review failures — **change your approach** rather than retrying the identical plan. Try a different decomposition, a different model, a simpler prompt, or break the node into smaller steps. Repeating the same failing plan wastes budget without progress.

### Crash recovery: a recovered workflow arrives paused

After a process restart, nodes that were mid-flight are failed conservatively
(`execution ownership lost on recovery`) — recovery never re-runs provider work
implicitly. The workflow then PAUSES instead of terminalizing, and you receive
the failed-node wake. Downstream nodes stay `pending`, so the graph is still
replannable. Dispose of it in the same turn:

- **Replan + resume (preferred)**: the failed node is terminal and immutable — add a replacement under a NEW id, rewire its pending dependents' `depends_on` to the new id, then `control(resume)`.
- **Resume as-is**: accept the failure. A required-node failure terminalizes the workflow as `failed` (attributed to the node ids); optional failures degrade and continue.
- **Cancel**: abandon the workflow.

Never assume a crashed workflow resumes or retries on its own — it will wait,
paused, until you act.

### Node failure triage: repair the failed node, don't restart

A node-failure wake is a work order for a **targeted repair**, not a restart
signal. Every node failed via `dag.node.failed` carries an `error_class` in
`status` output and in the wake summary. Exception: a node cancelled via replan
appears as `failed` with error_reason `cancelled via replan` and NO
`error_class` — deliberate action, no triage needed. Triage on the class
before acting:

| error_class           | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Correct response                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout`             | The node exceeded `timeout_ms`; the runtime cancelled its child session at the deadline. Environmental — the task is NOT wrong.                                                                                                                                                                                                                                                                                                                                                                                      | Replace and rerun ONLY that node with a larger `worker_config.timeout_ms`. Check its `child_session_id` for partial artifacts before rerunning.                                                                                                                                                                                                                                                                                                                                                      |
| `exec_failed`         | Runtime/session-level failure. Gate on `error_reason`: (a) unknown/wrong model, auth, rate-limit, connection, template-resolution or condition-expression errors → config/prompt errors; (b) recovery reasons ("no child session on recovery", "child session failed (recovered)") → crash ownership loss; (c) workflow-collateral reasons (`required node(s) failed: ...`, `unresolved review outcome(s): ...`, `orchestrator_unresponsive`) → the node itself was fine; it was failed because the workflow failed. | (a) Fix the config first (`dag.jsonc` tier, provider credentials, model id, template/input mapping), then replace and rerun ONLY that node. (b) Inspect the child session's artifacts, then replace and rerun. (c) Do not rerun these collateral nodes. The wake surfaces no workflow-level reason — triage from the Failed-nodes block: `required node(s) failed: <ids>` names the culprit nodes directly (repair them); `orchestrator_unresponsive` carries NO attribution (see the recipe below). |
| `verdict_fail`        | Two shapes. Ran-but-broke-contract: missing `submit_result`, schema rejection, review fingerprint mismatch. Never-ran: pre-spawn contract failures (unresolved template placeholders, review input contract).                                                                                                                                                                                                                                                                                                        | Ran-but-broke-contract → rerun the node with the contract stated explicitly; keep the topology. Never-ran → fix the template, input_mapping, or dependency wiring first, then rerun; prompt emphasis alone does not fix broken interpolation.                                                                                                                                                                                                                                                        |
| (cascade — see below) | Dependents of a failed node. No dedicated class.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Repair the ROOT node first, then restore the dependent subtree.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Cascade detection has two shapes:

- **Required node failed** → the workflow terminalizes `failed`; still-running nodes are failed with the workflow reason and all other pending/queued/paused dependents are terminalized to `skipped` with error_reason `workflow_failed` (dependents stay untouched only while the workflow is still `paused` — terminalization happens when the scheduler evaluates). The culprit is a node in the Failed-nodes block whose `error_class` is a real failure class; collateral rows carry the workflow reason instead.
- **Optional node failed** → dependents ran with `Dependency "X" failed: ...` / `Dependency "X" skipped: ...` interpolated into their prompt text (inspect the dependent's rendered prompt/input, not its `error_reason`). Judge per dependent whether its output is still valid with the degraded input.

In both shapes, repair the root/classed node first, then re-add the failed/skipped dependents rewired onto the replacement id.

`orchestrator_unresponsive` recipe (zero attribution by design — the parent
took no mandatory action while the workflow stalled): read `status`, identify
which nodes were `running` or stuck when the guard fired, then dispose per the
Verdict Disposal Contract: extend/replan those nodes, or change the approach
(see Escalation) if the stall repeats. Never repair collateral rows blindly.

The value set above is what the runtime produces today; `push_exhausted`
exists in the schema but is reserved and currently never emitted.

Budget exhaustion is a separate class: `replan attempt ceiling exceeded` or
`Total node ceiling exceeded` means the budget is spent — change the approach
or stop, do not retry the identical plan (see Escalation).

Where to apply the repair:

- **Workflow still live** (running/paused/stepping): `control(pause)` → `control(replan)` adding a replacement node under a NEW id (rewire the failed node's pending dependents onto it; use `restart: true` for still-running nodes) → `control(resume)`. `extend` with the replacement node also works. Completed siblings are untouched.
- **Workflow terminal `failed`**: terminal status is irreversible — you cannot replan it. Start a **continuation workflow** instead: reuse every completed node's output as static input (inject it into the downstream prompts; never re-run a completed node), re-add only the failed and still-pending tail, and record `reused_nodes` in the manifest.

Hard rule: an environmental single-node failure (timeout, wrong model, API
error, crash-recovery loss) never justifies restarting the workflow from zero.
Completed node outputs are durable and reusable; a full restart wastes paid
provider work and destroys evidence the earlier nodes already earned.

### Graph-action acceptance is not execution

`start`, `extend`, and `control(replan)` responses confirm that a graph was
**accepted**, not that its nodes **execute**. Acceptance-time validation does
not resolve template placeholders or map upstream outputs — spawn-time
contract failures (`verdict_fail`: unresolved placeholders, broken
input_mapping, condition-expression errors) kill freshly added nodes seconds
after a successful "Added" response, leaving a silent window where the wave
is believed to be running. Two disciplines close the gap:

- After any successful graph-carrying call, make ONE `status` read before
  reporting nodes as running: every newly added node must have left
  `pending` (a `child_session_id` or `running` status). An acceptance
  receipt alone is never evidence of execution.
- After any rejected graph-carrying call (SchemaError, validation error),
  fix the spec source AND re-issue the call in the same turn — corrected input
  is not a corrected operation, and the re-issue needs the same `status`
  verification.

## Model Assignment Strategy

Workflow YAML has no model-selection field. Resolution follows the `dag.jsonc`
tier, then the configured agent model, then the parent-session model. If all
three are absent, the workflow tool asks the user to configure a model and does
not create the workflow.

- Expensive models for planning, review, and arbitration — high-stakes decisions where reasoning quality matters.
- Fast models for mechanical implementation — well-specified edits where speed and cost matter.
- Diverse models in adversarial review — reduces single-model blind spots.

The two-tier defaults in `dag.jsonc` implement the split mechanically:
`required: true` nodes and `review`/`review-*` workers resolve to the
`advanced` tier, every other node to `standard`.

## Prompt Templates

Templates are read-only prompt fragments under `.opencode/dag-prompts/*.md`. Reference them by ID; they are read on spawn. Some templates declare required `{{variable}}` inputs — supply them via static `prompt_template.input` or `input_mapping`, because an unresolved placeholder fails the node loudly at spawn. Available templates:

- `code-explore` (requires `target`): Search codebase structure, output file paths + responsibilities
- `test-explore` (requires `target`): Search test structure, output coverage gaps
- `config-explore` (requires `target`): Search config/deploy files, output config inventory
- `arch-gate`: Review architecture constraints and approve direction
- `implement` (requires `spec`): Implement per specification
- `verify`: Verify completeness and compatibility
- `plan`: Synthesize findings into a structured plan
- `review-arch`: Review from architecture perspective
- `review-logic`: Review from logic correctness perspective
- `review-style`: Review from code style perspective
- `patcher-assemble`: Assemble clean patch from completed work
- `integration-test`: Run integration tests and report

Templates without a required variable consume their upstream inputs through the structured context appended from `depends_on` outputs. The review templates additionally force an `unverified_claims` section, which a verification wave downstream can check against the actual code.

For ad-hoc prompts, use `prompt_template: { inline: "...", input: {...} }`.
Static `prompt_template.input` supplies literal, local template values; it does
not read upstream node output. Inline templates interpolate those static values
and direct dependency variables. Use `input_mapping` when an upstream output
needs a stable variable name or field selection. When a mapped placeholder
contains an object or array, interpolation renders it as indented JSON; it must
never appear as `[object Object]`.

## Budget Declaration

The engine faithfully executes declared budgets and circuit-breaks on ceiling breach. It does not adaptively adjust — declare what your task needs. Default values are floors for light work, not recommendations: size every timeout and ceiling to the actual task load (target size, number of upstream reports a node must consume, expected tool/test/compilation work) and never trust the defaults blindly. Choose values based on task complexity:

- `max_concurrency`: default 5. For independent fan-out (e.g., generating 100 images, migrating 10 packages), declare 10–20 so nodes aren't serialized behind an artificially narrow pipe.
- `max_node_replan_attempts`: default 5. Increase only if you expect iterative quality-driven convergence (review → revise → review cycles on a single artifact).
- `max_total_nodes`: default 100. Increase for large-scale decompositions.
- `worker_config.timeout_ms`: default 10 minutes. Increase for long-running nodes (compilation, large test suites). Verifier and aggregator nodes are the most common timeout victims: a node that consumes several parallel reports and re-checks their claims against code runs sequentially and routinely needs 20–30 minutes (e.g. `timeout_ms: 1800000`) — declaring the fan-out lanes' budget for the fan-in lane is a recurring failure pattern.

## Single-Workspace Discipline

All nodes share the same workspace. Write conflicts are an orchestration concern, not an infrastructure one. Two tiers:

**Tier A — Disjoint write sets**: parallel nodes that write to non-overlapping files/paths can run concurrently without coordination. Structure the decomposition so each node owns a distinct module or file set.

**Tier B — Propose-then-assemble**: when disjoint write sets cannot be guaranteed, parallel nodes should only produce proposals (structured output via `output_schema` + `submit_result`), not directly write files. A single assembly node then applies the changes sequentially. The review point converges on the assembly node's diff, not on scattered parallel edits.

## Design Principles

- Each node is a real child session with its own message history, tools, and context window. There is no shared memory between nodes — data flows only through `depends_on` and `input_mapping`.
- `required: true` means failure fails the entire workflow (terminal status `failed`, attributed to the node ids; `cancelled` is reserved for explicit cancels). Use it for nodes whose output is indispensable (gates, core implementation). Omit it for nodes whose failure is recoverable.
- A successful fan-in node must actually contain the requested comparison,
  synthesis, or final decision. Unresolved placeholders, missing dependency
  outputs, or a claim that inputs were aggregated are not successful
  aggregation.
- Layers are computed automatically from `depends_on`. Nodes in the same layer execute concurrently up to `max_concurrency`. Do not try to control execution order beyond declaring dependencies.
- When a node declares `output_schema`, the child agent must call `submit_result` to submit its structured result. Failure to call `submit_result` before the session ends results in node failure (`verdict_fail`). Nodes without `output_schema` use plain text output (the final text part of the session).

## Tool Reference

### Actions

**start** — Create a workflow from `config` and optional `title`, `mode`, and
admission input stored in YAML. Pass a task-local YAML path for one-off work or
a saved workflow name returned by `list`, such as
`{ action: "start", spec_path: "<name-returned-by-list>" }`.
Returns the workflow ID. Nodes declare `depends_on` (node IDs); layers and
execution order are computed automatically.

**list** — Show saved workflow specs in project, global, and builtin scopes
with names, titles, bounded objectives, block or node counts, paths, and
validation status. This lists reusable specs, not running workflows; use
`status` for a workflow's live state.

**read** — Return one saved workflow as structured JSON without starting it.
Pass `spec_path`, then retarget generic objectives and block instructions in
the parent, write the edited result to YAML, and start that file by path.

**extend** — Add nodes to a running workflow. Existing nodes are unaffected;
new nodes are immediately eligible for scheduling if their dependencies are
met. It also accepts a genuinely additive wave after a reporting leaf
checkpoint naturally completed the current graph; an early
`control(complete)` workflow remains terminal. Put the new nodes under `nodes`
in a YAML file, then call
`{ action: "extend", workflow_id: "dag_...", spec_path: "extend.yaml" }`.

**status** — Read the durable state of one workflow and all of its nodes. Pass `workflow_id`. Use it when the user explicitly asks for current state or once before a decision that requires fresh state, such as replan/control. Do not poll a running workflow merely to wait: node reports and terminal outcomes wake the parent session automatically.

**result** — Read one node's complete durable output in bounded pages. Pass
`workflow_id` and `node_id`; when the response is truncated, pass its
`next_cursor` unchanged until no cursor remains. Wake messages contain only a
bounded preview plus the exact workflow/node reference, so use `result` before
verifying or synthesizing any output marked `truncated=true`. Never infer the
omitted content from its preview.

**control** — Control a running workflow:

- `pause` — let running nodes finish, don't spawn new ones (pause does NOT stop nodes that are already running). On a cancel/replan intent, always pause FIRST: it needs no fragment and freezes scheduling while you compose the replan, so the graph cannot terminalize under you.
- `resume` — resume scheduling
- `cancel` — cancel the entire workflow
- `replan` — put `fragment: { ... }` with the graph fields and node definitions in YAML and pass its `spec_path`; running nodes can be `restart: true` or `cancel: true`; pending nodes absent from the fragment are cancelled. Valid while paused — the pause → write file → replan → resume sequence is the safe path.
- `complete` — early-complete: remaining pending nodes are skipped (non-violation)
- `step` — advance exactly one ready node (the first by node ID lexicographic order), then wait. Use for controlled debugging or staged verification of a critical path. Unlike `pause`, which freezes all scheduling, `step` advances one node and re-waits. A second `step` while the stepped node is still running is rejected. Use `resume` to return to full-speed scheduling. Nodes are selected in lexicographic ID order for determinism.

### Node Fields

| Field              | Required | Description                                                                                                                                          |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | yes      | Unique node identifier, used in `depends_on`                                                                                                         |
| `name`             | yes      | Human-readable name                                                                                                                                  |
| `worker_type`      | yes      | Agent type (`explore`, `build`, `general`, `plan`, or custom)                                                                                        |
| `depends_on`       | yes      | Array of node IDs this node waits for (`[]` for root)                                                                                                |
| `required`         | no       | If true and this node fails, the workflow terminalizes as failed. Default: false                                                                     |
| `prompt_template`  | yes      | `{ id: "..." }` or `{ inline: "...", input: {...} }`                                                                                                 |
| `condition`        | no       | Expression evaluated before spawn; node is skipped if false                                                                                          |
| `input_mapping`    | no       | Map upstream node outputs into template variables                                                                                                    |
| `report_to_parent` | no       | If true, the parent agent is woken when this node completes or fails. The workflow's terminal status always wakes the parent regardless of this flag |
| `worker_config`    | no       | `{ timeout_ms }` — bounds node execution (defaults to 10 minutes if omitted)                                                                         |
| `output_schema`    | no       | JSON Schema; when declared, the child agent must call `submit_result` to submit structured output — failure to submit results in node failure        |
| `restart`          | no       | (replan only) Re-spawn this running node with new prompt                                                                                             |
| `cancel`           | no       | (replan only) Cancel this node                                                                                                                       |

### What NOT to expect

- No `node_complete` action — completion is automatic
- No `history` action — inspect a known workflow with `status`; browsing running workflows remains TUI-only (`list` shows saved specs, not running workflows)
- No runtime-side magical topology selection — the routing command (`/dag-auto`) selects and adapts saved reference graphs in the parent agent; the workflow runtime executes the resulting validated spec
