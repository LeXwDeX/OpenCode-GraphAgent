# Composable Workflow Blocks

Blocks are the high-level interface for assembling a one-off workflow. The
tool compiles them into ordinary durable DAG nodes before validation and
persistence. Existing node-based YAML remains compatible.

## Shape

Use `objective` and `blocks` inside `config` for **start**, or alongside
`blocks` for **extend**. A replan uses the same fields inside `fragment`.

```yaml
config:
  name: implement-session-recovery
  objective: Implement session recovery with focused tests and evidence-backed review.
  blocks:
    - id: map
      kind: explore
      instruction: Locate the ownership and persistence seams.
    - id: design
      kind: plan
      depends_on: [map]
    - id: implement
      kind: coding
      depends_on: [design]
      skills: [tdd]
    - id: checks
      kind: verify
      depends_on: [implement]
    - id: decision
      kind: review
      depends_on: [checks]
      skills: [code-review]
```

Each block accepts:

- `id`: unique dependency address and the ID of its compiled exit node.
- `kind`: `explore`, `plan`, `prototype`, `debug`, `coding`, `verify`,
  `review`, or `synthesize`.
- `depends_on`: upstream block IDs; omitted means a root block.
- `instruction`: target-specific text added to the built-in block contract.
- `skills`: relevant skill names the child loads lazily when available.
- `worker_type`, `required`, `report_to_parent`: optional overrides.

`objective` is required and is injected into every generated node. Use blocks
or nodes, never both. Block IDs use letters, numbers, underscores, and hyphens.
Dependencies must be acyclic; they may name blocks in the submitted fragment
or existing durable node IDs during **extend** and replan.

## Block contracts

- `explore`: read-only repository mapping and evidence collection.
- `plan`: implementation-ready decomposition, seams, checks, and risks.
- `prototype`: the smallest throwaway experiment that resolves a runnable
  uncertainty; it does not silently become production code.
- `debug`: expands to reproduce/evidence followed by root-cause diagnosis.
- `coding`: bounded production implementation plus focused tests and checks.
- `verify`: deterministic acceptance checks with explicit PASS/FAIL evidence.
- `review`: expands to independent standards and intent reviews, then one
  structured arbiter returning `ACCEPT | REVISE | REJECT | BLOCKED`.
- `synthesize`: resolves dependency outputs into the parent-facing result.

Every compiled block is required by default. `review` and `synthesize` report
to the parent by default; other blocks stay quiet. A block immediately after a
review gate is conditioned on `ACCEPT`. Because the condition language handles
one verdict reference, fan multiple review lanes into one review block before
continuing.

## Composition routes

Choose only blocks justified by current evidence:

- Product or architecture decision: parallel `explore` lanes → `plan` options
  → `review` or `synthesize`.
- Project feature: optional `explore` → `plan` → parallel `coding` packages →
  `verify` → `review`.
- Hard bug: `debug` → `coding` → `verify` → `review`.
- Runnable design uncertainty: `prototype` → `plan`; keep the prototype
  disposable unless the confirmed scope explicitly promotes it.
- Existing implementation review: `explore` scope lanes → `review`; add a
  separate verification block first when test evidence is required.

Do not add a phase merely because it exists. Skip exploration when repository
facts are already known, skip a prototype when ordinary inspection resolves
the question, and keep independent work parallel. Use `synthesize` only when
multiple outputs need reconciliation.

## Parent decision checkpoint

User qualification is not a DAG block. Before executable blocks start, the
parent gathers facts it can discover, creates recommended answers for every
material open decision, displays one compact decision brief, and asks for one
combined confirmation. The brief contains the recommended route, alternatives
only where they change the result, assumptions, risks, scope, and acceptance
evidence. A correction from the user updates the brief; unchanged confirmed
facts are not asked again.

After confirmation, encode the decision in `objective` and block instructions.
If the request is already fully bounded and confirmed, do not manufacture a
redundant checkpoint. Child nodes never ask the user to make product or scope
decisions.

## When to use low-level nodes

Drop to `nodes` for custom template bindings, several conditional branches,
special output schemas, exact retry/cancel/restart controls, or deep diff-review
metadata. Load `guide(topic=interface)` for the full node interface and
`guide(topic=policy)` for gate and recovery contracts. Do not poll a running
workflow; reporting blocks wake the parent when a decision is actionable.
