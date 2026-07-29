<!--
  Shared workflow-tool guidance. The /dag-flow command prepends its launch
  contract, while the workflow tool uses this neutral reference directly.
-->

# Workflow Orchestration

The `workflow` tool orchestrates heavy tasks as dependency-graph multi-agent workflows. Each node runs as a real child session with its own agent, tools, and optionally its own model. This skill covers when to start a workflow, how to structure it, and how to adapt it at runtime.

Compile every graph under the Tiered Orchestration Doctrine and Depth Ladder in the orchestration policy below: advanced-tier judgment nodes conduct and check, standard-tier nodes carry the volume, and accuracy is bought with breadth (concurrent fan-out) and depth (verdict-gated waves) rather than with a single trusted pass.

## When to start a workflow

A task is an implicit workflow candidate only when it has both a scenario
signal—such as multi-role review, brainstorming, swarm/cluster work,
multi-model analysis, or end-to-end development—and one of these structural
signals:

- **Staged**: clear phase boundaries where later phases depend on earlier outputs (explore → plan → implement → verify).
- **Parallelizable**: ≥3 independent sub-units can execute concurrently (same fix across 5 packages).
- **Quality gate**: intermediate output must pass review before downstream work begins (architecture review before implementation).
- **Adaptive scope**: discovery may reveal an unknown number of work packages or require a bounded repair wave.

A lone keyword such as "review" is not enough. An explicit `/dag-flow` request
does not require this implicit-trigger test. If a task fits in one context
window and has no inter-step dependencies, use the `task` tool instead. For
trivial work, use direct tools.

## Standard and deep workflow entry

Omitting the top-level start parameter `mode` preserves `standard` behavior. Use `deep` for explicit
deep intent or requests with at least two substantial complexity signals, such
as independent workstreams, cross-domain uncertainty, high blast radius,
conflicting constraints, evidence gathering, or multiple verification
perspectives.

Before a deep start, qualify the request interactively in the parent session
and pass `mode: deep` plus a versioned `READY` or informed `WAIVED` admission
record beside `config` in the `action: start` tool call. Do not put admission
QA inside the graph: its answers define the graph. Use the orchestration policy
below for QA modes, round budgets, verdict recovery, revision invalidation, and
waiver audit fields.

## Orchestration Lifecycle

Heavy tasks follow a meta-workflow: multiple workflows chained together, each producing a decision that shapes the next. The lifecycle is the two accuracy axes applied in sequence — breadth to cover the surface, depth to earn the verdict:

1. **Explore + brainstorm** — exploration nodes fan out over the codebase while independent generators propose approaches; a required synthesizer converges them into a design plus architecture inventory.
2. **Design review gate** — an advanced-tier gate node (`report_to_parent: true`, normalized verdict `output_schema`) rules on the design. `required: true` fails the workflow only when the gate node fails to execute or satisfy its output contract; a successful `REVISE` or `REJECT` is a business verdict, not an execution failure. Route the static ACCEPT path through a downstream `condition`, and dispose of a reported non-ACCEPT verdict per the Verdict Disposal Contract. Dependencies cannot cross workflow boundaries — a gate in a separate workflow receives the prior result as static input.
3. **Parallel execution** — the accepted design decomposes into module-level worker nodes with disjoint write sets, fanning into a required assembler.
4. **Verify + diff review + audit** — production assurance follows `implementation → verification(PASS) → diff review → final gate/audit` with fingerprint echo; `REJECT` routes through corrected implementation and verification before a new diff review. Progress tracking is updated to reflect what shipped.
5. **Expansion decision** — iterate (bounded `control(replan)` of affected nodes), extend (additional parallel nodes), separate phase (a new workflow once the previous is terminal), or complete (`control(complete)`).

Not every task needs all five phases: a well-specified task may enter at phase 3, a clear design with uncertain scope at phase 2. The lifecycle is a decision tree, not a pipeline. Concrete graph YAML for each shape is under Collaboration Patterns below.

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
    model:
      providerID: local-proxy-compatible
      modelID: glm-5.2
```

This is the preferred place for a workflow-wide model. If both the node and
`config.node_defaults.model` omit it, resolution continues to the selected
agent model and then the parent session model.

When overriding a model, split the provider and provider-local model ID:

```yaml
model:
  providerID: local-proxy-compatible
  modelID: glm-5.2
```

Do not put `local-proxy-compatible/glm-5.2` into `modelID` while also setting `providerID`; that repeats the provider prefix.
Omit `node.model` unless the user supplied an exact provider/model selection.
Qualitative requests such as "use a strong model" must not be converted into an
invented model identifier.

## Collaboration Patterns

Four structural patterns cover the common cases. Real workflows often combine them.

### 1. Staged Pipeline with Gate

Sequential phases where each depends on the previous. Insert a gate node between phases to block downstream execution until quality is confirmed.

```yaml
action: start
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
action: start
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
action: start
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
        required: [verdict, summary, findings, required_actions, next_action]
        properties:
          verdict:
            type: string
            enum: [ACCEPT, REVISE, REJECT, BLOCKED]
          summary: { type: string }
          findings: { type: array }
          required_actions: { type: array }
          next_action:
            type: object
            required: [operation, targets]
            properties:
              operation:
                type: string
                enum: [continue, extend, replan, complete, stop]
              targets: { type: array }
      prompt_template:
        inline: "Three reviewers produced findings. Submit one structured ACCEPT, REVISE, REJECT, or BLOCKED decision with deduplicated findings, required actions, and the next bounded workflow action."

    - id: deep-dive
      name: deep-dive
      worker_type: general
      depends_on: [arbitrate]
      condition: 'arbitrate.output.verdict != "ACCEPT"'
      report_to_parent: true
      prompt_template:
        inline: "The arbiter did not accept. Verify each required action against the actual code and produce a corrected, evidence-backed action plan."
```

Reviewer nodes may use different exact models when the user selected them;
otherwise omit `model` and let workflow, agent, and parent configuration provide
the defaults. The arbiter is `required: true` — its execution failure signals
that the artifact could not be confidently accepted, while its successful
business verdict must still be interpreted. On `ACCEPT` the conditioned
`deep-dive` node is skipped and the workflow completes; on any other verdict
it runs with the arbiter's findings as context, so a non-ACCEPT outcome can
never silently terminalize the graph.

### 4. Diverge-Converge (Brainstorm)

Multiple independent generators produce candidate solutions; a converger selects and refines.

```yaml
action: start
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

## Model Assignment Strategy

Each node MAY specify `model: { modelID, providerID }` to pin a specific model.
`modelID` is the provider-local model ID; never repeat `providerID` inside it.
If omitted, resolution follows `config.node_defaults.model`, then the configured
agent model and then the parent session model. Pin only an exact user-supplied
selection and never invent an identifier from a qualitative request.

- Expensive models for planning, review, and arbitration — high-stakes decisions where reasoning quality matters.
- Fast models for mechanical implementation — well-specified edits where speed and cost matter.
- Diverse models in adversarial review — reduces single-model blind spots.

The two-tier defaults in `dag.jsonc` implement this split mechanically:
`required: true` nodes and `review`/`review-*` workers resolve to the
`advanced` tier, every other node to `standard`. Prefer expressing the split
through tier placement rather than per-node pins.

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
needs a stable variable name or field selection.

## Budget Declaration

The engine faithfully executes declared budgets and circuit-breaks on ceiling breach. It does not adaptively adjust — declare what your task needs. Choose values based on task complexity:

- `max_concurrency`: default 5. For independent fan-out (e.g., generating 100 images, migrating 10 packages), declare 10–20 so nodes aren't serialized behind an artificially narrow pipe.
- `max_node_replan_attempts`: default 5. Increase only if you expect iterative quality-driven convergence (review → revise → review cycles on a single artifact).
- `max_total_nodes`: default 100. Increase for large-scale decompositions.
- `worker_config.timeout_ms`: default 10 minutes. Increase for long-running nodes (compilation, large test suites).

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

**start** — Create a workflow from a YAML-declared graph. Pass the graph as
`{ action: "start", config: { name, nodes, ...defaultsAndBudgets } }`; `nodes`
at the tool-call top level is only for `extend`, not `start`. Returns the
workflow ID. Nodes declare `depends_on` (node IDs); layers and execution order
are computed automatically.

**extend** — Add nodes to a running workflow. Existing nodes are unaffected;
new nodes are immediately eligible for scheduling if their dependencies are
met. It also accepts a genuinely additive wave after a reporting leaf
checkpoint naturally completed the current graph; an early
`control(complete)` workflow remains terminal.

**status** — Read the durable state of one workflow and all of its nodes. Pass `workflow_id`. Use it when the user explicitly asks for current state or once before a decision that requires fresh state, such as replan/control. Do not poll a running workflow merely to wait: node reports and terminal outcomes wake the parent session automatically.

**control** — Control a running workflow:
- `pause` — let running nodes finish, don't spawn new ones (pause does NOT stop nodes that are already running). On a cancel/replan intent, always pause FIRST: it needs no fragment and freezes scheduling while you compose the replan, so the graph cannot terminalize under you.
- `resume` — resume scheduling
- `cancel` — cancel the entire workflow
- `replan` — submit a YAML fragment; running nodes can be `restart: true` or `cancel: true`; pending nodes absent from the fragment are cancelled. Valid while paused — the pause → compose fragment → replan → resume sequence is the safe path.
- `complete` — early-complete: remaining pending nodes are skipped (non-violation)
- `step` — advance exactly one ready node (the first by node ID lexicographic order), then wait. Use for controlled debugging or staged verification of a critical path. Unlike `pause`, which freezes all scheduling, `step` advances one node and re-waits. A second `step` while the stepped node is still running is rejected. Use `resume` to return to full-speed scheduling. Nodes are selected in lexicographic ID order for determinism.

### Node Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique node identifier, used in `depends_on` |
| `name` | yes | Human-readable name |
| `worker_type` | yes | Agent type (`explore`, `build`, `general`, `plan`, or custom) |
| `depends_on` | yes | Array of node IDs this node waits for (`[]` for root) |
| `required` | no | If true and this node fails, the workflow terminalizes as failed. Default: false |
| `prompt_template` | yes | `{ id: "..." }` or `{ inline: "...", input: {...} }` |
| `model` | no | `{ modelID, providerID }` override |
| `condition` | no | Expression evaluated before spawn; node is skipped if false |
| `input_mapping` | no | Map upstream node outputs into template variables |
| `report_to_parent` | no | If true, the parent agent is woken when this node completes or fails. The workflow's terminal status always wakes the parent regardless of this flag |
| `worker_config` | no | `{ timeout_ms }` — bounds node execution (defaults to 10 minutes if omitted) |
| `output_schema` | no | JSON Schema; when declared, the child agent must call `submit_result` to submit structured output — failure to submit results in node failure |
| `restart` | no | (replan only) Re-spawn this running node with new prompt |
| `cancel` | no | (replan only) Cancel this node |

### What NOT to expect

- No `node_complete` action — completion is automatic
- No `list` / `history` actions — inspect a known workflow with `status`; broader browsing remains TUI-only
- No topology templates — templates are prompt fragments only; you design the graph
