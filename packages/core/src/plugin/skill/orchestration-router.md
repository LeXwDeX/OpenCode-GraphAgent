<!-- Built-in skill loaded lazily for project-level orchestration decisions. -->

# Orchestration Router

Turn one user objective into the smallest execution route that preserves user
control and produces verifiable evidence. The router decides; workflow blocks
execute. Do not copy the whole playbook into the parent response.

This skill belongs to the user-facing parent session. If the current prompt
identifies this session as a DAG child or assigns one bounded block, execute
that assignment directly and do not create a nested workflow.

## 1. Establish facts before asking

Read repository instructions and inspect enough code, tests, history, or
runtime evidence to answer discoverable questions yourself. Separate:

- confirmed facts;
- decisions only the user can make;
- runnable uncertainties best answered by a disposable prototype;
- implementation work suitable for child sessions.

Do not ask the user for file locations, conventions, or current behavior that
the repository can reveal.

## 2. Select the execution lane

Use direct work for conversation, a bounded lookup, or one or two isolated
utility scripts outside a project-level change. Use one task child for one
independent non-trivial leaf. Use one workflow without waiting for `/dag-flow`
whenever the objective changes project source or tests—even when only one
project file is expected—spans modules, requires repository-backed product or
architecture planning, or has staged, parallel, gated, or adaptive work.

Honor explicit “single agent”, “do not use DAG”, and direct-execution requests.
Keep all related work for one objective under one workflow ID; adapt it with
extend/replan rather than creating disconnected graphs.

## 3. Run one parent-owned decision checkpoint when needed

Use a decision checkpoint for material product choices, conflicting
constraints, high-blast-radius architecture, or an explicit GRILL request. It
must happen in the parent conversation before executable DAG blocks start.

Generate recommended answers proactively. Present one compact brief containing:

1. recommended route and why;
2. scope in/out and acceptance evidence;
3. assumptions and risks;
4. alternatives only where the choice materially changes the result;
5. one combined confirmation request.

Wait for that confirmation. Do not hide the recommendation inside tool output,
start speculative implementation, or delegate the questions to a child. If the
user changes an answer, revise only affected fields and ask one new combined
confirmation. If the request already supplies an equivalent confirmed brief,
do not repeat the checkpoint.

## 4. Compose blocks from the route

Call `workflow(action="guide", topic="blocks")` when the block interface is
not already in context. Select only justified blocks:

- product/design: evidence lanes → competing plans when useful → synthesis or
  review decision;
- feature: optional explore → plan → independent coding packages → verify →
  review;
- bug: debug → coding → verify → review;
- runnable uncertainty: prototype detour → update the plan;
- review-only: scope exploration → independent review and arbitration.

When a reusable route matches the topology, call
`workflow(action="read", spec_path="<route>")`, retarget the objective and
block instructions to the confirmed request, prune unjustified blocks, and
start the edited result as an inline spec. Start the saved `spec_path` directly
only when its target already matches exactly.

Use a skill name on a block only when it appears in the available skill
catalog. Test-first implementation and standards/spec review belong in their
respective coding and review blocks, not in the always-on router prompt.

## 5. Preserve ownership boundaries

The parent owns the confirmed brief, graph shape, user interaction, workflow
controls, checkpoint disposal, and final report. Children own repository
exploration, implementation, checks, and bounded review artifacts. Do not have
the parent perform executable leaf work after choosing a workflow.

Start only after required confirmation. Report the returned workflow ID and
end the turn; the runtime wakes the parent later. On wake, dispose of a
non-ACCEPT verdict by targeted extension/replan or a reasoned stop. Never poll
merely to wait, and never describe an unstarted graph as running.
