# ADR-0003: Reporting checkpoint gating at the authoring boundary

- Status: Accepted
- Date: 2026-08-17

## Context

On 2026-08-17 a hand-authored 15-node workflow (issue #320) ran 75 minutes to
`completed` although every one of its five decision checkpoints returned
`verdict: replan`. The checkpoint nodes carried `report_to_parent: true` but
their stage dependents declared only `depends_on`, no `condition`. The engine
spawns a dependent the moment all of its dependencies complete, so each next
stage started milliseconds (≈12ms) after its checkpoint settled; the wake to
the parent was terminal-only advisory signal, never a gate. The authoring
model ignored warning-level feedback, which is how the ungated shape shipped.

Block-compiled graphs already gate dependents on checkpoint verdicts (the
issue #294 REJECT-checkpoint shape); hand-built node graphs had no equivalent
check.

## Decision

A `report_to_parent: true` node with dependents is a **reporting checkpoint**.
Each dependent must gate on the checkpoint's output via `condition`
(`input_mapping` does not count — it feeds data, it does not gate), or the
checkpoint must be a reporting leaf, or the node must drop `report_to_parent`.
`node_defaults.report_to_parent` is honored: a node inheriting the default
reports the same way.

Enforcement lives in `checkpointGateDiagnostics`, wired only into
`validatePostCompile`'s structural branch — the authoring start/validate path.
Every ungated dependent emits one error-severity `dag.invalid` diagnostic in
both `portable` and `environment` profiles, so `start` and `validate` reject
the shape before any durable graph exists.

Enforcement is authoring-only by design. `Dag.create` and the replan/extend
fragment paths stay untouched: the verdict vocabulary is open, the ACCEPT path
must not wait for the parent, and runtime enforcement would change the
semantics of every existing graph, including issue #294's wake-chain and
reopen-extend behavior.

## Consequences

- Ungated reporting checkpoints fail fast at start/validate with a diagnostic
  naming the checkpoint, the dependent, and the three legal fixes.
- Runtime create, wake chains, and reopen-extend semantics are unchanged;
  trusted internal callers retain full runtime flexibility.
- Saved and curated workflows were audited: 14 curated block workflows are
  unaffected; only `ultra-flow-route.yaml` and `release-route.yaml` trip the
  new check and are tracked in opencode-dag-config#14.

## Alternatives Considered

- Runtime enforcement at `Dag.create`: rejected — the verdict vocabulary is
  open-ended, the ACCEPT path must not block waiting for the parent, and it
  would change the behavior of every existing graph.
- Warning-severity diagnostic: rejected — the authoring model ignores
  warnings; that is precisely how the incident happened.
- A new explicit `gate` field on dependents: rejected — `condition` already
  expresses output gating and the block compiler already emits it; a second
  mechanism would split the gating vocabulary.

## Deferred

- Replan/extend fragments are not checkpoint-gate-checked (coverage gap; no
  date). Runtime flexibility was prioritized; fragment authoring remains
  advisory.
- Deprecation of advisory wake chains (no date): `report_to_parent` without
  gated dependents stays legal but is a smell worth revisiting once fragment
  coverage exists.
