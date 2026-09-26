# Reasoning distillation delivery review (2026-09-26)

Issues: [#631](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues/631), [#638](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues/638), [#643](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues/643)

## Review result

The design contract, pure core, OpenCode adapter, AI SDK transport, Native transport, and Core runner lifecycle passed the module-local TDD suites recorded in section "Test evidence" below (Core package: 1417 pass / 0 fail; targeted distillation, transport, and native suites: 122 pass / 0 fail, re-run per change and re-bound to the final SHA before delivery). "Accepted" therefore means those suites passed on the named commit — not provider-side approval, not a real-model effect claim, and not DEV artifact acceptance. The implementation is fail-closed: without an exact dual-evidence compatibility record and explicit source-to-final-wire lineage, original reasoning is sent unchanged.

The earlier statement that no production request path invoked propose/judge/cache is obsolete. All three request paths now invoke a cancellable lifecycle, reserve quota before the auxiliary call, account provider-reported usage and latency, pause paid admission on missing or over-reserve usage, and process multiple exact slots without allowing more than one auxiliary call per ordinary request. The remaining product-level boundary is an isolated installed DEV run on the final integrated commit and one authorized real tuple; that evidence belongs to the final integration pass, not this module-local TDD receipt.

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
| Core config, claims, gates, planning, cache, budget, runner and projection    |            93 passed |
| Frozen long-task corpus                                                       |             1 passed |
| OpenCode adapter, AI SDK/Native lifecycle and controlled transport            |           122 passed |
| Total dedicated/current affected tests                                       | 216 passed, 0 failed |

The controlled transport suite proves:

- the final OpenAI-compatible Chat payload changes only the authorized `reasoning_content` slot;
- tool-call order and tool continuation remain unchanged;
- no compatibility record preserves the original payload;
- signed or unsettled sources remain protected;
- missing, conflicting, incomplete, or multi-part lineage cannot authorize rewriting;
- duplicate text cannot bind by text alone;
- audit-only canaries never enter the model-visible payload.

Runtime lifecycle tests additionally prove:

- one propose/judge identity cannot reset its quota by switching model, provider, endpoint, or organizer;
- quota/reservation is persisted before an interruptible call, so cancellation and late completion cannot revive it;
- missing usage or actual usage above the reserved amount pauses later paid calls while keeping the original request;
- replay reuses an accepted candidate without another auxiliary call;
- later reasoning slots are not starved by an already validated first slot, while each ordinary request still issues at most one auxiliary call;
- the same lifecycle runs through AI SDK, Native, and Core runner request paths.

## Frozen long-task evaluation

`packages/core/test/fixtures/reasoning-distillation-long-task-corpus.json` freezes three accepted long-task histories and one contradicted completion. This corpus is a deterministic regression fixture only: its usage figures, prices, and reuse counts are frozen inputs that drive the assertions, so the numbers below prove the evaluator behaves deterministically on this fixture — they are not a measured real-model effect, a real bill, or a substitute for the 20-session synthetic-content real-model corpus/holdout required by #636.

The current local run accepted 3/3 valid projections, rejected the contradicted completion, retained 6/6 approved claims, retained every required technical term, and introduced zero repeated action markers. Across eight subsequent sends per accepted history, estimated realized savings were 354856 tokens against 20370 auxiliary tokens (`0.0574` auxiliary/savings) — frozen-fixture arithmetic, not observed provider usage. Under the frozen comparison prices, estimated saved input cost was USD 0.354856, auxiliary cost was USD 0.02214, and net comparison benefit was USD 0.332716. The deterministic corpus test completed in 8.20 ms; wall time is a regression diagnostic, not a provider latency claim.

Real-model evidence (authorized tuple application chain and the 20-session holdout) is collected separately in `docs/reasoning-distillation-real-model-evidence-2026-09-27.md`; that document supersedes this section wherever the two disagree.

The SDK compatibility review and authorized raw-wire observations are recorded in `docs/ai-sdk-reasoning-compatibility-2026-09-26.md`. They authorize no application tuple by themselves because they do not bind raw response, normalized reasoning, persisted history, TUI reload, and continuation to one live GraphAgent run.

## Open acceptance items

These remain required before #643 can close:

1. Bind one explicitly authorized tuple through raw response, normalized reasoning, persisted session, TUI reload, distillation input, and a later tool/assistant continuation using the final integrated artifact.
2. Pass the final repository-local CI matrix, then current PR-head CI and isolated installed DEV acceptance on the exact integrated commit.

Until those integration items are complete, module-local implementation and TDD are accepted, but the end-user product is not yet marked delivered.
