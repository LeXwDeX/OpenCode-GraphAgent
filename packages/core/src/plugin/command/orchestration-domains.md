# Orchestration Domains

Productized workflow playbooks for recurring heavy-task domains. Each playbook
composes the existing primitives — profiles, review lifecycle, actionable
checkpoints, bounded repair, and the pause-first replan protocol — into a
repeatable graph shape. Resolve every role below as a capability slot per Role
Resolution: prefer a configured agent whose contract matches (an explore-style
scout, a reasoner-style logic prober, a review-style verdict gate, a
verify-style test runner), fall back to `explore`, `build`, or `general`.

Every playbook is a mix of the two accuracy axes from the Tiered Orchestration
Doctrine — **breadth** (concurrent independent slices, standard tier) and
**depth** (verdict-gated iteration, advanced-tier judge) — at a different
ratio. Each heading names its ratio. Place decomposition, gate, verification,
and arbitration nodes on the advanced tier (`required: true` or a
`review`/`review-*` worker); leave the fan-out volume on the standard tier.

## The Simulated Audit Loop

Iteration in a DAG is NOT a cyclic edge and NOT a harness loop. It is a
verdict-driven replan wave — the depth axis in its pure form:

1. An audit node declares `output_schema` with a normalized `verdict` and
   `report_to_parent: true`.
2. On `REJECT` or `REVISE`, the wake delivers findings to the parent. Per the
   Verdict Disposal Contract the parent MUST act in that turn: it issues
   `control(pause)`, then `control(replan)` appending a correction node and a
   NEW audit node under NEW ids (terminal nodes are immutable), wires
   `depends_on` forward, then `control(resume)`. If the audit node was the
   terminal leaf, `extend` a fresh audit wave instead.
3. Repeat until the audit returns `ACCEPT`. The loop is bounded by
   `max_node_replan_attempts` and `max_total_nodes` — on ceiling breach stop
   with `BLOCKED` and report the residual findings instead of retrying the
   identical plan.

Every playbook below that says "audit loop" means exactly this mechanism.

## Playbook: Deep Review

Ratio: breadth then depth. Multi-role adversarial review of whether a code
structure or design is sound, scaled by the Depth Ladder.

- **Breadth wave** — fan out 3+ reviewers with genuinely conflicting mandates:
  a prosecutor (argues the structure is wrong — coupling, hidden invariants,
  failure modes), a defender (argues the current shape is justified —
  constraints, history, cost of change), and dimension specialists
  (architecture, correctness, testability) as scope demands. Every reviewer
  MUST cite file:line evidence and list what it could not confirm as
  `unverified_claims`.
- **Verification wave (mandatory for module scope and larger)** — one or more
  verify-style nodes check the disputed and `unverified_claims` items against
  the actual code before any verdict. This is what separates a review from a
  poll of opinions; skipping it lets an unproven assertion become a finding.
- **Arbitration (advanced tier)** — fan in to one arbiter that rules
  finding-by-finding on the VERIFIED evidence, not merely concatenating
  reviews, and emits the actionable checkpoint shape (`verdict`, `findings`,
  `required_actions`, `next_action`).
- Pre-implementation structure reviews are `design` phase. Reviewing an actual
  change requires the diff-phase hard contract:
  `implementation → verification(PASS) → diff review` with fingerprint echo.
- **Depth wave** — on `REVISE`/`REJECT`, drive corrections and concurrent
  deep-dives into the confirmed problem areas through the audit loop. The
  arbiter's report is the start of this wave, never the end of the task.

## Playbook: Deep Speculation

Ratio: breadth of parallel probes, then depth through the revision loop.
Prophesy a whole design document — stress-test it end to end and emit an
automated verdict with zero human gates in the middle.

- Internalized grill method, run as graph roles instead of user Q&A: parallel
  nodes over the same document — a logic simulator (walk the described system,
  surface contradictions and boundary gaps), an adversarial interrogator
  (produce the hardest material questions: hidden assumptions, falsifiers,
  failure modes, evidence quality), and an alternatives prober (steelman one
  competing shape).
- A responder node answers the interrogation strictly from the document plus
  codebase evidence, marking each question ANSWERED / GAP / CONTRADICTION.
- An arbiter synthesizes everything into a structured prophecy: verdict,
  ranked risks, unresolved gaps, and a concrete revision list — then the audit
  loop applies revisions and re-speculates until ACCEPT.
- Fully automated: no admission QA rounds with the user mid-flight. Reserve
  interactive `GRILL` admission for before the workflow starts.

## Playbook: Large Engineering

Ratio: iterated breadth and depth — parallel packages, each gated, plus a
final audited review. Turn an execution document (todo list, work ledger, or
spec) into audited, parallel-safe delivery.

1. **Deep analysis** — scout nodes map the affected surface; an analyst node
   decomposes the document into work packages with explicit dependency edges
   and disjoint write sets (the tickets: each package states its blocking
   edges, not a bare list).
2. **Orchestrate** — compile the packages into a graph: independent packages
   fan out in parallel, dependent ones serialize, propose-then-assemble where
   write sets may overlap.
3. **Audit the plan** — a plan-audit node checks the decomposition itself:
   missing edges, false parallelism, unstated assumptions, acceptance criteria
   per package. `REJECT` re-orchestrates via the audit loop until the plan
   passes.
4. **Execute** — run the audited graph with the develop-profile phases each
   package still needs; verification consumes each implementation before any
   diff review.
5. **Final adversarial review** — the Deep Review playbook over the assembled
   result, with its own audit loop.
6. **Deliverable** — a final assembler emits the outcome report: shipped
   packages, evidence, residual risks.

## Playbook: Solution Bake-off

Ratio: pure breadth — N samples of the same goal, one advanced-tier judge.
N competing approaches implemented or prototyped in parallel against the same
acceptance criteria; a verify-style node exercises each candidate; one arbiter
picks the winner on evidence and records why the losers lost.

## Playbook: Root-Cause Diagnosis

Ratio: breadth of hypotheses first, then depth on the leading survivor.
Fan out one node per plausible hypothesis, each tasked to falsify its own
hypothesis with concrete evidence; an arbiter eliminates, ranks survivors, and
either declares the root cause or replans a deeper probe wave on the leading
survivor.

## Playbook: Audit Sweeps

Ratio: pure breadth per sweep cell, with the audit loop supplying depth on
hits. The same fan-out/arbiter/audit-loop shape covers recurring sweep
domains: security surface audit (per-surface reviewers: input handling,
authz, secrets, dependencies), regression matrix fan-out (one verify node per
axis cell), and docs-code drift audit (per-document checkers comparing claims
against the code, with fix waves through the audit loop).

## Choosing and Combining

Playbooks compose inside one live DAG: Large Engineering embeds Deep Review at
its gate; Deep Speculation can front-load any of them. Selection still obeys
Execution Mode Selection and the Depth Ladder — its wave count meets the
ladder's minimum for the target size, and explicit user constraints always
override the playbook shape.
