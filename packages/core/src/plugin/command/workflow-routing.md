# Orchestration Router

The parent owns workflow qualification, saved-reference selection, and block
composition. Children execute assigned blocks and never start nested workflows.

Do not discover, load, or apply an external Skill to select the workflow route.

## Execution mode

- Direct execution: conversation, a small read-only lookup, or isolated utility
  scripts outside a project-level change.
- One `task` child: one independent non-trivial leaf assignment.
- One `workflow` DAG: project-level source or test changes, even one project
  file; cross-module work; repository-backed product or architecture work; or
  staged, parallel, quality-gated, or adaptive execution.

An explicit request for one agent, direct work, or no DAG selects direct work.
Related work for one objective stays under one workflow ID; extend or replan
that workflow when evidence adds work.

A read-only request keeps every selected child read-only but does not by itself
change the execution mode. Preserve named roles, exact model assignments,
scope limits, and prohibited actions in every child prompt.

## Qualify before composing

Inspect repository evidence before asking. Separate confirmed facts, runnable
uncertainties, user-owned decisions, and executable work.

When a product or architecture decision materially changes behavior, scope,
acceptance, or an irreversible boundary, present one **Decision Checkpoint**
before executable blocks start. Its **Workflow Brief** states the recommendation,
scope, acceptance evidence, assumptions, risks, and materially different
alternatives. Ask for one combined confirmation; skip it when the request
already confirms an equivalent brief. Children never ask product or scope questions.

## Select one reference

Unless the user named an exact saved `spec_path`, call `workflow(action="list")` before authoring. Select only a returned name; never guess a route name. Choose
exactly one primary saved reference by the deliverable:

- product planning — decide what or why to build;
- technical design — produce an implementation-ready system or migration design;
- project development — deliver a confirmed project change;
- debug and repair — reproduce a defect, prove its cause, and repair it;
- code review — return a verdict on a pinned implementation change or diff;
- security audit — return a code, trust-boundary, authorization, or supply-chain verdict;
- performance audit — return a measured resource or scale verdict.

When the list contains a matching pair, apply these tiers. Use `lite` only when all
are true: goal and acceptance evidence are confirmed, one module and write owner
suffice, work is reversible, and no high-risk boundary is involved. Use `full`
when any are true: requirements or design are uncertain; work crosses modules
or write owners; a public contract, concurrency, persistence, migration,
identity, authorization, upstream executable dependencies, CI/release, or
production behavior is in scope. Only these risk dimensions select a tier —
never role count or block count, which are consequences of risk, not causes.
A single matching custom workflow has no tier to infer: read and retarget it
directly.

If a lite reporting gate returns non-`ACCEPT`, let that graph finish and
dispose of the verdict under the Verdict Disposal Contract. When the findings
cross any `full` criterion above, the correction wave MUST be full-shaped:
escalate by appending full-shaped assurance lanes with new node IDs in the
same workflow — a tier escalation is an additive wave, never a replacement
workflow. Do not pause or replan a completed workflow; the parent owns this
control decision.

The primary reference follows the final artifact, not every concern. For code
or repairs, review, security, and performance are secondary assurance in that
DAG; for a verdict, the matching audit is primary. Do not concatenate two complete references; copy only secondary blocks that change acceptance.

## Compose the smallest justified graph

Read the selected reference, retarget its objective and instructions, and
remove phases current evidence already covers. Start its saved `spec_path`
directly only when target and acceptance evidence match. If none fits, compose
a task-local graph. Load `guide(topic="blocks")` for block contracts and
`guide(topic="patterns")` only when domains overlap. Use low-level nodes only
for fields blocks cannot express.

Prefer `workflow(action="draft")` over hand-writing YAML: pass the structured
`config` (same fields as the YAML below) and the tool renders and validates the
spec file, returning the `spec_path` to start. Field-name drift is impossible
because the parameter schema rejects unknown fields. Hand-write YAML only for
features draft does not carry (admission, custom bindings). The exact start
shape, for that fallback and for reading draft output:

```yaml
title: Implement session recovery
config:
  name: implement-session-recovery
  objective: Implement session recovery with focused tests and review.
  blocks:
    - id: map
      kind: explore
      instruction: Locate the ownership and persistence seams.
    - id: coding
      kind: coding
      depends_on: [map]
    - id: review
      kind: review
      depends_on: [coding]
```

Top level is `title`/`mode`/`admission` (optional) and `config` (required);
`objective` lives INSIDE `config`; every block field is one of `id` (required),
`kind` (required), `depends_on`, `instruction`, `worker_type`, `worker_config`,
`required`, `report_to_parent` — never `worker`, `prompt`, or `agent`.

A `report_to_parent` node with dependents is a reporting checkpoint: gate each
dependent on its output via `condition`, keep it a reporting leaf, or drop
`report_to_parent`.

Validate that `spec_path` before start. Fix every diagnostic in the same file
and revalidate; validation creates no workflow. A successful start returns the
exact workflow ID. The parent owns the graph, controls, and final report;
children own bounded work. End after start and let the workflow wake the
parent. Do not poll merely to wait or claim an unstarted graph is running.

## Progressive guidance

`guide` without a topic is the index. Topics: `blocks` for block shape,
`interface` for low-level fields, `policy` for recovery, and `patterns` for
cross-domain conflicts. Load only the needed topic.

The tool parameter schema owns action fields and `spec_path`; on-demand guides
own YAML fields; validation is the file authority.
