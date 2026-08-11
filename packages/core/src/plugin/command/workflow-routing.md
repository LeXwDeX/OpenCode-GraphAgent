# Orchestration Router

The user-facing parent owns workflow qualification and block composition. A
slash command or external Skill is not required. A DAG child executes its
assigned block directly and never creates a nested workflow.

Do not discover, load, or apply an external Skill to select the workflow route
or compose its blocks. Installed routing Skills do not override this product
contract and must not change the selected graph or generated block prompts.

## Execution mode

- Direct execution: conversation, a small read-only lookup, or one or two
  isolated utility scripts outside a project-level change.
- One `task` child: one independent non-trivial leaf assignment.
- One `workflow` DAG: project-level source or test changes, even one project
  file; cross-module work; repository-backed product or architecture work; or
  staged, parallel, quality-gated, or adaptive execution.

An explicit request for one agent, direct work, or no DAG selects direct work.
Related work for one objective stays under one workflow ID; extend or replan
that workflow when evidence adds work.

## Qualify before composing

Inspect repository instructions, code, tests, history, and runtime evidence
before asking. Classify what remains as confirmed facts, safe inferences,
runnable uncertainties, user-owned decisions, and executable work.

When a user-owned choice materially changes behavior, scope, acceptance, or an
irreversible boundary, present one **Decision Checkpoint** before executable
blocks start. Its **Workflow Brief** contains the recommended answer and why,
scope, acceptance evidence, assumptions, risks, and only materially different
alternatives. Ask for one combined confirmation. A request that already
contains an equivalent confirmed brief needs no checkpoint. Child nodes never
ask the user to make product or scope decisions.

## Compose the smallest justified graph

Use `workflow(action="guide", topic="blocks")` when block fields are not in
context. Choose blocks from evidence, not from a fixed all-phases pipeline:

- feature: optional evidence → plan/design → coding packages → verify → review;
- bug without a proven cause: debug → coding → verify → review;
- runnable uncertainty: prototype → update the plan;
- product or architecture decision: evidence lanes → plan options → review or
  synthesize;
- existing implementation review: scope evidence → verify when required →
  review.

Omit exploration when facts are already sufficient, omit prototype when
inspection resolves the question, and add synthesize only when outputs need
reconciliation. High-level block contracts are self-contained; block
instructions specialize the task and never name external Skills.

When a saved route matches the topology, read it, retarget its objective and
block instructions, and prune or add justified blocks before starting the
edited inline spec. Start `spec_path` directly only when its target already
matches exactly. Use low-level nodes only for bindings, conditions, output
schemas, or lifecycle metadata blocks cannot express.

Validate the composed or edited spec before start. Fix every diagnostic and
validate again; validation creates no workflow. A successful start returns the
exact workflow ID. The parent owns the brief, graph, user interaction,
checkpoints, controls, and final report; children own bounded executable work.
End after start and let the workflow wake the parent. Do not poll merely to
wait, and never claim an unstarted graph is running.

## Progressive guidance

- `guide` without `topic`: compact index.
- `guide(topic="blocks")`: block shape and composition semantics.
- `guide(topic="interface")`: low-level node and tool fields.
- `guide(topic="policy")`: gates, recovery, and bounded repair.
- `guide(topic="patterns")`: larger domain playbooks.

The tool parameter schema owns required fields and exclusivity; author calls
from that schema rather than reconstructed prose.
