# Heuristic DAG guidance

## Scope and evidence

The user reported that GPT frequently starts DAGs for small tasks and asked
for model judgment over both execution mode and graph composition. During this
conversation, a prompt revision was itself delegated to a DAG; the user then
explicitly requested direct execution. That workflow was cancelled before any
source changes, and this patch was implemented directly without child tasks.

The original resident router required a DAG for project changes even to one
file. The policy imposed file/module depth minimums, compulsory tier-based
division of work, and full-shaped escalation. The core command tests pinned
those exact instructions. `/dag-auto` selected ultra-flow for broad requests.

## Changes and predictions

### chg-1: execution choice belongs to task judgment

Owner: resident workflow-tool description (`workflow-routing.md`).
The causal rule was categorical routing, not merely forceful vocabulary.
Replace category triggers with expected benefit versus coordination cost;
direct execution, one delegated task, and a DAG are available options.
Risk can justify better verification without more agents. Explicit user
execution choices still take precedence. No mandatory scoring or explanation
ritual is introduced for routine direct work.

Prediction: bounded edits, debugging, and read-only questions can complete
directly without library discovery or graph creation. Independent parallel
work can still use a DAG when useful. Risk: the model may under-delegate;
evaluate evidence quality and completion, not only DAG-call frequency.

### chg-2: composition examples are not quotas

Owner: runtime-owned policy, interface, block and cross-domain guides.
Remove fixed wave/reviewer counts and compulsory full-template escalation;
allow parent-side verification or repair after child writers stop. Separate
actual model-tier mapping and compiler review contracts from optional labor
division. A read-only review may finish by reporting findings rather than
automatically creating a repair wave.

Prediction: loading a detailed guide does not reinstate mandatory orchestration
or repeated reviews. Risk: useful assurance could be omitted. Claims still need
evidence, and schema, ownership, permissions, cancellation, runtime budgets and
fingerprint-bound review behavior are unchanged.

### chg-3: explicit orchestration does not imply a full pipeline

Owner: `/dag-auto` command description and prompt.
Retain the meaning of an explicit DAG request while making templates optional
and removable phases clear. Remove default ultra-flow, a fixed retry count for
that command, and assumed checkpoint output shapes. Ask only about unresolved
user-owned choices; respect later direct/no-DAG instructions.

Prediction: broad requests do not automatically run every saved stage, and
explicitly bounded reviews do not grow into implementation or release work.

## Verification and falsification

Two new exported-guidance tests failed against the original text before the
rewrite. Tests cover the heuristic choice criteria and absence of identified
mandatory routing/depth clauses across connected prompt surfaces. Existing
tests still cover real schema, model assignment, read-only and review contracts.
The tool execution test checks the description actually returned by tool init;
the command test checks argument preservation and the expanded command prompt.

Local verification on 2026-09-17:

- `packages/core`: `bun test test/plugin/command.test.ts` passed 25 tests.
- `packages/opencode`: `bun test test/command/command.test.ts test/dag/workflow-tool.test.ts test/tool/workflow-provider-schema.test.ts test/tool/workflow-schema-contract.test.ts --timeout 30000` passed 85 tests.
- `bun run typecheck` passed in both affected packages.
- Root `bun run lint` passed with 4833 warnings and zero errors, below the
  unchanged 4850-warning ceiling.
- `git diff --check` passed.

These are prompt-contract and runtime integration tests, not proof of GPT's
decision quality. Replay small edits, bounded CI questions, independent parallel
work, explicit DAG requests, and explicit no-DAG requests under the rebuilt
runtime before claiming behavioral acceptance. Compare actual tool calls,
completion evidence, latency and unnecessary stages. If a prediction fails,
revise or roll back its owning layer rather than stacking stronger instructions.

## Boundaries

No engine state machine, provider routing algorithm, permission boundary or
output schema changed. Existing runtime recovery budgets remain intact.
Curated templates in the separate config repository and installed/global
configuration were not edited. Source changes do not rewrite instructions
already injected into a running session.

CI work remains in its separate stash; context-folding work is untouched.
SpecGit inspection was blocked by an old branch's local delivery checkpoint
(`ownership_conflict`). That checkpoint was not altered; no Issue association,
commit, push, PR or release is claimed by this local patch.
