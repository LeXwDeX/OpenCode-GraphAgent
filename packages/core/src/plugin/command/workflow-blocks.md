# Composable Workflow Blocks

Blocks are the high-level interface for assembling a one-off workflow YAML
file. The tool compiles them into ordinary durable DAG nodes before validation
and persistence. Existing node-based YAML remains compatible.

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
    - id: codebase-design
      kind: plan
      depends_on: [map]
      instruction: Define the owning seam, deep interface, migration path, and acceptance evidence.
    - id: coding
      kind: coding
      depends_on: [codebase-design]
      instruction: Deliver the bounded design through observable tests and focused checks.
    - id: verify
      kind: verify
      depends_on: [coding]
    - id: global-review
      kind: review
      depends_on: [verify]
```

This guide owns the author-written block fields and semantics. The action
schema stays shallow and accepts only `spec_path`; the YAML validator rejects
unknown or missing graph fields by name and reports each error with its path.

`objective` is required and is injected into every generated node. Use blocks
or nodes, never both. Block IDs use letters, numbers, underscores, and hyphens.
Dependencies must be acyclic; they may name blocks in the submitted fragment
or existing durable node IDs during **extend** and replan.

## Block contracts

- `explore`: read-only repository mapping and evidence collection.
- `plan`: decision- or implementation-ready options/work packages, checks,
  falsifiers, and risks.
- `prototype`: the smallest throwaway experiment that resolves a runnable
  uncertainty; it does not silently become production code. It still publishes
  its changed-file list and fingerprint so later verification or review cannot
  bind to stale experiment evidence.
- `debug`: expands to reproduce/evidence followed by root-cause diagnosis.
- `coding`: bounded production implementation plus focused tests and checks.
- `verify`: deterministic acceptance checks with explicit PASS/FAIL evidence.
- `review`: design/content inputs expand to independent standards and intent
  reviews plus a general arbiter. An implementation input must follow a
  `coding → verify(PASS) → review` route; the compiler binds the implementation
  fingerprint through both reviews into an `ACCEPT | REJECT` decision.
- `synthesize`: resolves dependency outputs into the parent-facing result.

Block contracts are self-contained. `instruction` specializes a lifecycle kind
into a capability such as `codebase-design`, `domain-modeling`, or
`global-review`; it never delegates the method to an external Skill.

Judgment and acceptance gates (`plan`, debug diagnosis, `verify`, review
decision, and `synthesize`) are required by default. Volume lanes (`explore`,
`prototype`, `coding`, debug evidence, and independent review lanes) are
optional by default; an explicit `required` value on a block overrides its
default. `review` and `synthesize` report to the parent by default; other blocks
stay quiet. A block immediately after a review gate is conditioned on its
accepted verdict. Because the condition language handles one verdict reference,
fan multiple review lanes into one review block before continuing.

All block workers share one workspace. The compiler serializes
otherwise-unordered `coding` and `prototype` writers, while read-only lanes may
remain parallel. The resident Orchestration Router owns route selection and
phase pruning; this guide owns block fields, contracts, and graph mechanics.

## When to use low-level nodes

Drop to `nodes` for custom template bindings, several conditional branches,
special output schemas, exact retry/cancel/restart controls, or deep diff-review
metadata. Load `guide(topic=interface)` for the full node interface and
`guide(topic=policy)` for gate and recovery contracts. Do not poll a running
workflow; reporting blocks wake the parent when a decision is actionable.
