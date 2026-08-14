# Cross-domain Workflow Composition

The resident Orchestration Router and the live workflow library own route and
`full`/`lite` selection. This guide resolves only requests where several domain
references appear relevant. Keep one primary reference and one workflow.

## Pick the backbone by the final artifact

- The requested deliverable is a product decision: keep product planning as
  the backbone; technical feasibility is evidence, not a second design route.
- The requested deliverable is an implementation-ready design: keep technical
  design as the backbone; product context supplies constraints.
- The requested deliverable is changed code: keep project development as the
  backbone unless an unknown defect first requires causal diagnosis.
- The requested deliverable is a defect repair: keep debug and repair as the
  backbone; the repair, regression proof, and review stay in that graph.
- The requested deliverable is a verdict: use code review for a pinned
  implementation change, security or performance audit for those evidence
  domains, and technical design when the object is a proposed system or
  migration.

Security, performance, and review are secondary assurance when the requested
artifact remains implementation or repair. They become primary only when the
requested artifact is their report or verdict. A secondary concern is never a
second workflow for the same objective.

## Add the smallest assurance slice

Read the primary reference first. Read a secondary reference only to identify
the minimum evidence lane or gate that changes acceptance. Put those blocks in
one task-local YAML and retarget every copied instruction to the same scope and
acceptance criteria. Do not append a complete second reference.

- A security-sensitive feature keeps the development backbone and adds scoped
  threat, authorization, secret, or supply-chain checks before final review.
- A security defect keeps the debug backbone and adds exploitability and
  boundary verification around the causal repair.
- A performance repair keeps the debug or development backbone and adds a
  repeatable baseline plus before/after measurement.
- A review of a dependency or release change keeps the review backbone and adds
  only the relevant upstream provenance and reachability evidence.

Reuse one exploration result across consumers. Keep one verification fan-in
for the final implementation fingerprint and one final review or synthesis;
duplicate explore, verify, and verdict blocks are evidence drift, not extra
assurance. Unordered writers still share one workspace, so give them disjoint
write sets or serialize them with real dependencies.

## Preserve lifecycle contracts

Composition does not redefine block fields, verdicts, repair, or recovery.
Load `guide(topic="blocks")` for YAML shapes and block semantics, and
`guide(topic="policy")` for admission, verdict disposal, pause-first replan,
and bounded repair. A non-ACCEPT verdict remains actionable in the same wake
turn; do not invent a domain-specific retry loop.
