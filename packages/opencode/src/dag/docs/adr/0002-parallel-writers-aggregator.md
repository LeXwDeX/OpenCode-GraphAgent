# ADR-0002: Parallel workspace writers with an implementation aggregator

- Status: Accepted
- Date: 2026-08-16

## Context

The block compiler used to chain every unordered `coding` and `prototype`
writer into one serial lane before the graph reached the runtime. Saved
routes advertised parallel implementation slices that never overlapped in
execution, so the runtime's concurrency budget bought nothing for the phase
where time pressure is highest. The serialization existed because the diff
review gate binds one implementation reference and one fingerprint: with
several independent writers there is no single canonical source of
implementation evidence.

The fingerprint contract is a worker-reported value verified by echo
(implementation report → reviewer echo → settlement equality), not a
cryptographic binding to the worktree, so centralizing where the fingerprint
is produced does not change what it is.

## Decision

Unordered writers compile to truly parallel nodes; the runtime semaphore
schedules them within the workflow's `max_concurrency`. Writer ordering only
exists where the author declared it.

When an implementation review covers writers with no total order, the
compiler injects one aggregation node per review route:

- The aggregator depends on every writer of the route, runs read-only with
  shell access, is required, and reuses the implementation output schema.
- It receives each writer's declared `changed_files` and fails its node
  loudly on any non-empty write-set intersection; otherwise it publishes the
  union plus one fingerprint computed at the convergence point.
- The verify block's writer dependencies are re-pointed to the aggregator,
  the diff review's implementation reference points at the aggregator, and
  the verify node receives the implementation fingerprint binding.

Writer chains that already have a total order keep the canonical-writer
behavior and compile byte-identically. Overlap of an author-defined block id
with a generated aggregator id is rejected by the existing duplicate-node
check.

Author discipline for parallel writers is the triple-disjoint rule — source
files, generated artifacts, and lockfiles disjoint, and no shared build —
owned by the plan block's work packages. Mechanical enforcement is the
aggregator's changed-file intersection check; shared-cache and lock-contention
races remain plan discipline.

## Consequences

- The runtime, review lifecycle, settlement, and recovery paths are untouched;
  they observe ordinary durable nodes with an ordinary implementation schema.
- The empty fingerprint promise in the verify contract is filled by the
  verify binding for aggregated routes.
- Compiled graphs for parallel implementation routes gain one node per
  review route; node ceilings must account for it.
- Block guide wording and saved-route wording must describe parallel writers
  truthfully; the serialization claim is removed.
