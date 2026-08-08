# DAG system review — 2026-08-09

## Outcome

The review found one reproducible correctness defect, fixed it before any
architecture work, and found no second defect that could be reproduced through
a supported runtime path. The scheduling core is modular and well covered. The
remaining work is change-locality and recovery hardening, not a rewrite.

## Scope and evidence

Reviewed surfaces:

- graph validation, admission, scheduling, transitions, projection, and store
  code under `packages/core/src/dag`;
- workflow commands, runtime scheduling, recovery, spawning, wake delivery, and
  summary publication under `packages/opencode/src/dag` and
  `packages/opencode/src/tool/workflow.ts`;
- DAG inspector state, reducers, layout helpers, and rendering under
  `packages/tui/src`;
- durable events and generated boundary types used by those packages.

Verification baseline:

- `packages/core`: 90 targeted DAG tests passed;
- `packages/opencode`: 389 targeted DAG tests passed before the fix, 392 after
  adding three deterministic regressions;
- `packages/tui`: 50 targeted DAG tests passed;
- `packages/opencode`: `bun typecheck` passed;
- the `dev` push CI for the fix passed Linux E2E; Linux unit and Windows E2E
  were still running when this report was written.

Coverage is strongest at the core state-machine seams: graph validation,
scheduling, transitions, admission, evaluation, and projection are effectively
fully covered. Runtime execution is also high but less complete:
`src/dag/runtime/loop.ts` was 93.73% line / 92% function, spawn 94.58% line,
recovery 99.30% line, and the workflow tool 89.81% line / 79.49% function.
Coverage alone did not expose the confirmed timing defect.

## Confirmed bug — fixed

### Summary updates could be lost during an in-flight read

`packages/opencode/src/dag/runtime/summary-publisher.ts` used a `Set` as an
early-return coalescer. An event arriving while a workflow or Session summary
read was already running observed the key in the set and returned. The active
read could have captured the old state, and no dirty rerun was scheduled, so
the TUI could remain stale until an unrelated later event.

Three `Deferred`-gated regression tests reproduced the lost update for:

1. two events for one workflow;
2. two workflows sharing one parent Session;
3. a newer event arriving while the first read fails.

The fix replaces the boolean in-flight set with keyed dirty state. Events
during debounce are absorbed; events during an active read mark the key dirty;
completion or failure reruns once with the latest durable state. Interruptions
still propagate. The fix is merged to `dev` in PR #202.

## Architecture findings

### A1 — Runtime loop has poor change locality (high, no behavior change yet)

`packages/opencode/src/dag/runtime/loop.ts` constructs most runtime behavior
inside one roughly 1,200-line `layer` closure. It owns adoption, subscriptions,
child-session ownership, spawn planning, wake batching, delivery, recovery,
and terminal decisions. The public module is deep, but the internal
collaborators are invisible to code navigation and can only be tested through
the whole layer.

Recommended boundary: keep one public runtime layer, but extract cohesive
private constructors for child ownership, wake delivery, and recovery. Each
constructor should receive the minimum services it uses and expose only the
operation needed by the coordinator. Do this in behavior-preserving commits
after adding tests for the uncovered failure branches.

### A2 — Workflow command dispatch mixes transport and domain preparation (medium, scheduled)

`packages/opencode/src/tool/workflow.ts` has one 200+ line `execute` switch
(cyclomatic complexity 21, cognitive complexity 64). It combines parameter
validation, file/YAML transport, admission normalization, model readiness,
domain commands, and user-facing receipts. This coupling is also why a one-off
graph must be written to YAML before it can start.

The next product change will introduce one spec-source boundary: inline
structured specs are the default for one-off start/extend/replan operations;
`spec_path` remains for saved workflows. Action handlers may be extracted only
where this names a real boundary and lowers the main dispatch complexity.

### A3 — Core and TUI seams are appropriately deep (retain)

The core splits graph rules, scheduling, transitions, projection, and storage
into independently testable modules. The TUI consumes server summaries and
keeps non-trivial layout logic in pure utilities. Recombining these modules or
moving aggregation into the TUI would make the system harder to verify.

## Unconfirmed robustness risks

These are review observations, not bugs. No supported-path red test was found.

- `readWakeBatch` catches typed failures, while store database failures are
  defects (`orDie`). A defect can postpone delivery until another event or
  restart. Add an explicit retry policy only after a fault-injection test
  proves the desired semantics.
- Startup recovery intentionally admits that a store defect can defer
  redelivery until the next restart. This is operationally weak, but changing
  it requires a retry/backoff and shutdown contract.
- The final review-acceptance guard does not re-check an output fingerprint.
  Normal spawn and recovery paths validate fingerprints before settlement, so
  no supported writer currently reaches the stale state. Keep this as
  defense-in-depth backlog unless a reachable sequence is demonstrated.

## Batch C decision

The `spawnReady` O(ready × nodes) candidate remains closed without code. Current
workflow limits and observed test/runtime scale do not show material cost, and
the scheduling implementation is easy to reason about. Reopen only with a
profile showing scheduling latency or CPU cost at realistic node counts.

## Ordered follow-up

1. Ship the inline workflow-spec and parent-orchestrator policy change.
2. Refactor `runtime/loop.ts` behind regression tests, without changing the
   public layer contract.
3. Add store fault injection, then decide retry/backoff semantics from evidence.

