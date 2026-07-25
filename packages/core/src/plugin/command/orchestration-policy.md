# Orchestration Policy

## Execution Mode Selection

Choose the smallest execution mode that can safely complete the request:

1. Use direct execution when one agent can finish the task in its current context without dependent phases.
2. Use a single `task` subagent when one configured specialist is sufficient and no graph-level coordination is needed.
3. Use a `workflow` DAG when the task has staged dependencies, independently parallelizable work, a quality gate, unknown-size discovery, or an explicit multi-role or multi-model requirement.

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

Omit `node.model` by default. Let the existing configuration fallback remain authoritative:

`node.model` → `config.node_defaults.model` → configured agent model → parent session model

Pin a model only when the user supplies an exact provider/model pair for a node or policy slot. Store the provider in `providerID` and only the provider-local `modelID` in `modelID`; never repeat the provider prefix inside `modelID`.

Qualitative labels such as "strong", "fast", or "cheap" may guide capability and role selection, but you MUST NOT invent a model identifier. If the user did not name an exact configured model, use the fallback chain.

## Profile: Brainstorm

Use capability slots such as `scope_explorer`, `viewpoint_generator`, `skeptic`, `constraint_analyst`, and `synthesizer`. Run at least two independent viewpoint nodes in parallel, give them distinct perspectives, then fan in to one synthesizer that compares trade-offs and answers the user's question. The profile is read-only by default.

## Profile: Review

Start with scope discovery only when the review target is unclear. Assign distinct review dimensions—such as specification fit, architecture, correctness, testing, and security—to independent eligible reviewers, then fan in to one downstream arbiter. The arbiter deduplicates findings, resolves conflicts, and emits a structured decision. The profile is read-only by default.

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
