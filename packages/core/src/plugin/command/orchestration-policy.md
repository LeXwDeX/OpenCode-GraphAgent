# Orchestration Policy

This file is the operating procedure. Where background prose or an example
elsewhere appears to permit a shallower graph, this procedure wins.

## Tiered Orchestration Doctrine

Every non-trivial orchestration is a tiered division of labor:

- **Advanced-tier nodes** own the decisions that must be correct: task
  decomposition, gates, claim verification, arbitration, final synthesis.
- **Standard-tier nodes** own the volume: exploration, mechanical
  implementation, per-angle analysis, test execution.

Tier placement is mechanical, not a model-ID choice: `required: true` nodes
and `review`/`review-*` workers resolve to the advanced model tier of
`dag.jsonc`; every other node resolves to standard. Mark conductor and critic
nodes accordingly instead of inventing model identifiers. With a single
configured tier the role split still applies — compensate for the weaker
judge with more redundancy below.

The standard tier buys accuracy with redundancy on two axes:

- **Breadth (space for accuracy)**: independent slices fan out concurrently —
  work packages, hypotheses, review dimensions, or N samples of the same
  question when one cheap pass is unreliable — and fan in to one
  advanced-tier arbiter.
- **Depth (iteration for accuracy)**: unreliable or high-stakes conclusions
  are re-earned across waves — analyze → verify claims against ground truth →
  deepen on what survived — bounded by `max_node_replan_attempts`.

Hard rules:

1. The advanced tier MUST NOT do bulk work the standard tier can fan out.
2. The standard tier MUST NOT render a final verdict: every deciding fan-in
   routes through an advanced-tier gate or arbiter.
3. A standard-tier claim stays unverified until a verification step has
   checked it against ground truth (code, tests, executable evidence).

## Depth Ladder

Hard minimums by target size; user constraints may lower them only when
explicit ("quick pass", "single agent", a stated budget) — a bare task phrase
like "review X" never does.

- **File or function scope**: one analysis wave plus one synthesis node.
- **Module scope**: at least exploration → independent analysis → claim
  verification → arbitration. A single wave of parallel opinions is not a
  review; it is a poll.
- **Subsystem or repo scope**: a domain playbook with planned continuation
  waves (verdict-driven replan or extend), never a one-shot graph.

## Execution Mode Selection

Choose the smallest execution mode that can safely complete the request:

1. Use direct execution when one agent can finish the task in its current context without dependent phases.
2. Use a single `task` subagent when one configured specialist is sufficient and no graph-level coordination is needed.
3. Use a `workflow` DAG when the task has staged dependencies, independently parallelizable work, a quality gate, unknown-size discovery, or an explicit multi-role or multi-model requirement.

"Smallest" is measured against the Depth Ladder: a mode or graph that cannot
deliver the ladder's hard minimum for the target size is not safe, merely
small.

Outside an explicit `/dag-flow` request, select a DAG only when the request contains both a scenario signal and a structural signal. Scenario signals include multi-role review, brainstorming, swarm or cluster work, multi-model analysis, and end-to-end development. Structural signals include independent viewpoints, multiple work packages, staged gates, unknown-size discovery, and requested iteration. A lone keyword such as "review" is not sufficient.

Explicit user constraints override profile defaults:

- "single agent", "do not use DAG", and "answer directly" disable implicit workflow selection.
- "Do not modify files" does not disable a useful brainstorm or review DAG; it makes every node read-only.
- Preserve named roles, exact model assignments, scope limits, and prohibited actions in every node prompt.

## Deep Admission QA

`standard` remains the compatibility default and may start without admission.
Simple or already-bounded work stays `standard` and MUST NOT be forced through
deep admission QA. Recommend `deep` only when the request has at least two deep-complexity signals: independent workstreams, cross-domain uncertainty,
high blast radius, conflicting constraints, evidence gathering, or multiple
verification perspectives. Explicit `deep` intent still requires admission; it
selects the mode, not a bypass.

Run admission before constructing or starting the graph. Questions belong to
the existing parent-session question interaction because the answers define the
graph. You MUST NOT create an admission child node, QA workflow, separate
persona, or privileged command. `GRILL-ME` selects `GRILL`; equivalent explicit
requests for adversarial qualification do the same.

Cover these six dimensions, asking only material unresolved questions:

1. goal;
2. scope;
3. constraints and assumptions;
4. acceptance criteria;
5. evidence and review;
6. risks and failure modes.

Use one adaptive policy with bounded modes:

- `LIGHT`: at most 1 question round for a nearly complete brief.
- `STANDARD`: at most 3 question rounds and the default for deep admission.
- `GRILL`: at most 5 question rounds, probing contradictions, hidden
  assumptions, evidence quality, failure modes, and falsifiers.

Stop early as soon as the brief is ready. Exhausting a budget with unresolved
blockers yields `NOT_READY`; it never silently yields `READY`.

Maintain a versioned Requirement Brief with this structure:

```json
{
  "goal": "string",
  "scope": {
    "in": [],
    "out": []
  },
  "constraints": [],
  "assumptions": [],
  "acceptance_criteria": [],
  "evidence_required": [],
  "risks": [],
  "review_plan": [],
  "open_questions": [],
  "blocking_questions": []
}
```

Before start, show a concise brief summary and verdict:
`READY | NOT_READY | WAIVED`, plus QA mode, brief revision, fingerprint, and
remaining blockers. `READY` requires a non-empty goal, scope boundaries,
acceptance criteria, evidence obligations, review plan, and no blocking
questions. For `NOT_READY`, remain in the parent conversation and offer:
continue QA, reduce scope, use `standard`, or explicitly waive. A `WAIVED`
start is informed only when both `waiver_reason` and `acknowledged_risks` are
non-empty; preserve them for audit.

Compute `fingerprint` exactly as the workflow boundary does: trim `goal`; for
every array in the Brief, trim strings, remove blanks, and sort them; preserve
the documented key order; then SHA-256 hash the compact JSON object and encode
it as lowercase hexadecimal. Use normal local calculation tools rather than
inventing a digest.

Material changes to goal, scope, constraints, assumptions, or acceptance
criteria create a new brief revision, invalidate the prior fingerprint, and
return admission to questioning. Only a successful deep workflow start consumes
a `READY` or `WAIVED` record. Do not replay QA from a consumed record after
recovery.

## Role Resolution

Profiles declare capability slots, not fixed agent names. Resolve each slot in this order:

1. an eligible explicit `@agent` assignment from the user;
2. an eligible configured agent whose name or description matches the capability;
3. a compatible documented built-in role;
4. a compatible `explore`, `build`, or `general` fallback.

If a required capability has no eligible role, report the missing capability and do not start the workflow. You MUST NOT invent a `worker_type`.

## Model Assignment

Never emit `node.model` or `config.node_defaults.model`. Model assignment belongs
to runtime configuration, not the workflow graph:

`dag.jsonc` tier → configured agent model → parent session model

Qualitative labels such as "strong", "fast", or "cheap" guide tier placement,
but you MUST NOT invent a model identifier. If every configured source is
missing, the workflow tool starts parent-session QA and does not create the
workflow. Ask the user to configure a `dag.jsonc` tier, the selected agent, or
the parent-session model, then retry.

Prefer expressing "strong model for judgment, fast model for volume" through
tier placement — `required: true` and `review`/`review-*` workers resolve to
the advanced tier of `dag.jsonc`, everything else to standard — rather than
graph-level model fields.

## Profile: Brainstorm

Use capability slots such as `scope_explorer`, `viewpoint_generator`, `skeptic`, `constraint_analyst`, and `synthesizer`. Run at least two independent viewpoint nodes in parallel, give them distinct perspectives, then fan in to one synthesizer that compares trade-offs and answers the user's question. The profile is read-only by default.

## Profile: Review

Scale the graph with the Depth Ladder before compiling, then wire the
verdict's continuation path.

- File or function target: assign distinct review dimensions—such as
  specification fit, architecture, correctness, testing, and security—to
  independent eligible reviewers, then fan in to one downstream arbiter.
- Module target or larger, four waves minimum:
  1. scope exploration fanning out over the target's real structure;
  2. distinct review dimensions in parallel, every reviewer REQUIRED to cite
     file:line evidence and to list claims it could not verify as
     `unverified_claims`;
  3. a claim-verification wave that checks disputed and unverified claims
     against the actual code, so unproven assertions never reach the verdict;
  4. one downstream arbiter (advanced tier) that rules finding-by-finding on
     verified evidence, deduplicates findings, resolves conflicts, and emits
     a structured decision.
- The arbiter MUST NOT be a silent end of the graph: either gate an in-graph
  continuation node on `condition: 'arbiter.output.verdict != "ACCEPT"'`, or
  rely on the Verdict Disposal Contract at the wake boundary — choose one
  deliberately at compile time.

The profile is read-only by default.

## Profile: Develop

Choose only the phases the task still needs:

1. requirement and codebase exploration;
2. specification and architecture gate;
3. interface and TDD work;
4. business implementation across safe work packages;
5. integration and wiring;
6. parallel review and arbitration;
7. bounded targeted repair;
8. verification, CI when available, final audit, and report.

Omit phases whose evidence is already satisfied. Connect dependent phases explicitly, and run only independent work packages in parallel.

## Review Lifecycle

Name what a review can actually prove. A pre-implementation review is a
`design` review of requirements, architecture, threat model, plan, or test
strategy. It may appear in the flow `design review → implementation`, but it
MUST NOT claim implementation-diff assurance, code-correctness verification, or
executed-test evidence.

A production implementation review uses:
`implementation → verification(PASS) → diff review → final gate/audit`.
The implementation supplies an actual diff or changed-file artifact and an
implementation fingerprint. Verification consumes that implementation and must
return `PASS` before the diff review can run. The diff review returns
`ACCEPT | REJECT` and echoes the reviewed fingerprint.

Route rejection through a finite correction wave:
`REJECT → corrected implementation → verification(PASS) → new diff review`.
If implementation changes, the old review fingerprint is stale and cannot
satisfy a final gate.

Synthetic stress-test graphs may intentionally place reviews early to exercise
fan-out and fan-in. Label those nodes `design` reviews and state the limitation;
they MUST NOT claim implementation-diff assurance merely because their worker
type says review.

## Gates and Business Verdicts

`required: true` handles execution failure; it does not interpret a successful business verdict. A gate that successfully returns `REVISE` or `REJECT` is a completed node, not a failed node.

Declare `output_schema` for gates and arbiters and normalize `verdict` to `ACCEPT`, `REVISE`, `REJECT`, or `BLOCKED`. Use a downstream `condition` for a static branch. When the decision changes graph shape, set a checkpoint and let the parent select an existing workflow control action.

## Verdict Disposal Contract

A gate, arbiter, or auditor verdict is a work order, not a summary. When a
checkpoint reports `REVISE`, `REJECT`, or `BLOCKED`, the parent MUST dispose
of it in the same wake turn with exactly one of:

1. `extend` — append a bounded correction or deep-dive wave targeting the
   findings. This remains valid after a reporting leaf checkpoint naturally
   completed the workflow.
2. `control(pause)` → `control(replan)` → `control(resume)` — when the live
   graph must change shape.
3. A new workflow — when the previous one terminalized and the follow-up
   needs a fresh graph; state which prior results carry over.
4. A reasoned stop — tell the user, finding by finding, why no further wave
   is warranted. Silence is not a stop decision.

Merely summarizing a non-ACCEPT verdict and ending the turn is an
orchestration failure. The runtime's `orchestrator_unresponsive` guard only
fires for workflows that are still live; a checkpoint that terminalizes its
workflow escapes that guard, so this contract is the only enforcement at the
terminal boundary and applies with full force exactly there. For `BLOCKED`
on a ceiling breach, do not retry the identical plan — report residual
findings and stop or change approach.

## Actionable Checkpoints

Normal leaf workers use `report_to_parent: false`. Gates, arbiters, and final auditors use `report_to_parent: true` only when their result requires graph-level action. Their structured output follows this shape:

```json
{
  "verdict": "ACCEPT | REVISE | REJECT | BLOCKED",
  "summary": "string",
  "findings": [],
  "required_actions": [],
  "next_action": {
    "operation": "continue | extend | replan | complete | stop",
    "targets": []
  }
}
```

Do not poll `status` merely to wait. Atomic wake reports actionable checkpoints and workflow terminal outcomes. Use `status` only when the user asks for current state or once before a control decision that requires fresh durable state.

## Bounded Repair

Implement review-and-repair with finite `extend` or `control(replan)` operations. Target only the nodes and findings that require repair. You MUST NOT create cyclic `depends_on`, predeclare unbounded speculative repair waves, or start an unrelated replacement workflow.

Declare a finite `max_node_replan_attempts`. When the ceiling is exhausted, stop with `BLOCKED`, report the remaining findings, and do not retry the identical plan.

## Replan Protocol (pause-first)

A replan fragment takes real time to compose — template rendering, model reasoning, node rewiring. While you compose it, the workflow keeps scheduling and can reach a terminal status, after which replan is rejected (terminal workflows are immutable). Freeze first, then think:

1. On any user cancel/replan/model-change intent, IMMEDIATELY issue `control(pause)` in the same turn. Pause needs no fragment, applies in milliseconds, and stops new node spawns.
2. Pause does not interrupt nodes that are already running. Decide their disposition inside the fragment: `restart: true` re-spawns a running node with the new definition (its in-flight child session is hard-aborted at re-spawn), `cancel: true` terminates it, absence keeps it running to completion.
3. Compose the fragment, then issue `control(replan)` — replan is valid while paused.
4. Issue `control(resume)` to restore scheduling.

If the workflow terminalized before you paused, do not force the replan: start a new workflow carrying the updated definitions, and state which prior results are superseded.
