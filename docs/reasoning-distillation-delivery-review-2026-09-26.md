# Reasoning distillation delivery review (2026-09-26)

Issues: [#631](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues/631), [#638](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues/638), [#643](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues/643)

## Review result

The design contract, pure core, OpenCode adapter, and controlled AI SDK transport are locally accepted. The implementation is fail-closed: without an exact dual-evidence compatibility record and explicit source-to-final-wire lineage, original reasoning is sent unchanged.

The product is **not yet accepted as live**. No production request path currently invokes the adapter's propose/judge/cache lifecycle. Native/Core runtime activation, real persisted-session/TUI reload, frozen long-task quality acceptance, current PR-head CI, and installed DEV acceptance remain open in #643. This review intentionally does not repeat the stale 2026-09-23 statement that the locally deliverable work was “all complete.”

## Design confirmation

- Triggering is budget-based: `ContextFoldingBudget.overBudget === true`.
- Auxiliary purpose never distills itself.
- Output is Chinese structured text while technical identifiers remain verbatim.
- One candidate binds to one slot, one source fingerprint, one capability fingerprint, and one final wire position.
- Signed, encrypted, unsettled, ambiguous, multi-part-without-lineage, stale, rejected, malformed, or unsupported input preserves the original request.
- Preserved spans are copied from the original source text after range and fingerprint verification.
- The stored source history is not mutated; projection uses a private outbound copy.
- Propose and judge quotas, cache size, derived-body size, and amortized auxiliary-call admission are bounded.
- Audit attribution keeps source-agent execution findings separate from distiller conservation findings.

## Local evidence on the integrated branch

Dedicated tests run with Bun 1.3.14:

| Scope                                                                        |               Result |
| ---------------------------------------------------------------------------- | -------------------: |
| Core config, claims, gates, planning, cache, budget, eligibility, projection |            91 passed |
| OpenCode adapter and controlled AI SDK transport                             |            48 passed |
| Total reasoning-distillation tests                                           | 139 passed, 0 failed |

The controlled transport suite proves:

- the final OpenAI-compatible Chat payload changes only the authorized `reasoning_content` slot;
- tool-call order and tool continuation remain unchanged;
- no compatibility record preserves the original payload;
- signed or unsettled sources remain protected;
- missing, conflicting, incomplete, or multi-part lineage cannot authorize rewriting;
- duplicate text cannot bind by text alone;
- audit-only canaries never enter the model-visible payload.

The SDK compatibility review and authorized raw-wire observations are recorded in `docs/ai-sdk-reasoning-compatibility-2026-09-26.md`. They authorize no application tuple by themselves because they do not bind raw response, normalized reasoning, persisted history, TUI reload, and continuation to one live GraphAgent run.

## Open acceptance items

These remain required before #643 can close:

1. Wire a real, cancellable propose/judge/cache lifecycle into AI SDK, Native, and Core request paths.
2. Prove timeout, cancellation, late-result rejection, cache invalidation, multi-slot behavior, replay, and model/provider switching on those live paths.
3. Freeze and review a representative long-task corpus with nonempty accepted projections and report claim retention, repeated-action rate, latency, and token/cost impact.
4. Bind one explicitly authorized tuple through raw response, normalized reasoning, persisted session, TUI reload, distillation input, and a later tool/assistant continuation.
5. Pass current PR-head CI and isolated installed DEV acceptance on the merged commit.

Until those items are complete, the shipped code is a safe, tested foundation and controlled transport proof, not an enabled end-user product feature.
