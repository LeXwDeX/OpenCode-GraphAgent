# Reasoning Distillation — 20-Session Real-Model Holdout (2026-09-27)

Issue: #643 / #636. Corpus and raw results are reproducible: fixed seed
`20260927`, generator and runner scripts kept outside the repo (ephemeral
harness), aggregated metrics below derived from the 20 per-session result
files.

## Corpus

20 synthetic-content sessions (`holdout-01` … `holdout-20`), 3 turns each,
each embedding 5 seed-derived gold facts (ids `FACT-<code>-1..5`) plus a
~60KB reference filler to cross the distillation budget gate. Main model
`qwen-max`, organizer `glm` (authorized tuple; see the companion real-model
evidence document). Serial execution; per-session isolated data dirs.

## Headline metrics

| Metric | Value |
| --- | --- |
| Sessions executed | 20 / 20 |
| LLM sends | 60 |
| Auxiliary calls issued | 77 |
| Auxiliary outputs passing full candidate parse | 74 (96.1%) |
| Auxiliary tokens metered (`aux_actual_tokens` sum) | 279,402 |
| Unknown-usage calls | 5 (one session, `holdout-14`, ended admission-paused) |
| Sessions with `applied=true` | 0 (see "Judge stage" below) |
| Gold coverage, raw (facts named in any accepted candidate) | 74/100 (74%) |
| Gold coverage over the distillable surface (facts present in a proposed reasoning slot) | 74/80 (92.5%) |
| Proposal output size vs reasoning slot size (parsed candidates) | ~4.9× (claims+coverage JSON is larger than the source slot; the compression payoff lands only when a projection replaces history, which requires the judge stage) |

## Analysis

- **No information loss.** In every session the full source history (including
  all gold facts) remains persisted; `applied=false` everywhere means no
  projection ever replaced history, so nothing could be lost. Spot audit of a
  low-coverage session (`holdout-09`) confirmed all five fact ids present in
  the stored parts.
- **Coverage misses decompose into two causes.** (a) 20 of the 100 gold facts
  were never on the distillable surface: the main model stated them in its
  *text* parts rather than reasoning, and distillation by design only
  compresses reasoning slots — those facts remain verbatim in history. (b) 6
  surface misses (sessions `holdout-03`, `holdout-07`): facts were present in
  a proposed slot but the organizer's candidate did not emit claims for them.
  Because the judge stage never approved these candidates (below), they were
  never applied — the fail-closed posture kept sources intact.
- **Fail-closed behavior confirmed at scale.** 5 unknown-usage calls paused
  paid admission in `holdout-14`; all other sessions metered cleanly
  (`unknown=0`, `paused=false`).
- **Per-request single-aux cadence works**, reservation accounting tracked
  `promptTokens + maxOutputTokens` per call, and one session (`holdout-11`)
  exercised a 12.7K-token proposal well inside the 262,144 session ceiling.

## Judge stage (accepted projections) — not yet observed live

`applied=true` never occurred in the holdout sessions. The propose→judge→apply
sequencing is verified by in-process E2E tests
(`proposes on the first … request and applies only after the second-cycle
judge`, 49 tests passing). Live verification was blocked by two findings:

1. The holdout runner drives each user turn as a separate CLI process; the
   lifecycle state (ledger + candidate cache) is process-resident, so the
   judge request never shared state with its propose. Long-lived processes
   (TUI/server) do not have this limitation.
2. A judge-starvation defect was found and fixed during analysis: the
   multi-slot cycle iterated strictly newest-first and stopped at the first
   attempted slot, so each new request's fresh reasoning slot pre-empted the
   judge of the previous request's candidate. The cycle now advances pending
   judges before fresh proposals (unit + E2E suites pass).

With the fix, live judge verification requires a long-lived session harness
(one process, consecutive gated requests); it is recorded as the remaining
follow-up rather than asserted as done.

## Verdict for #643

**Refs (not Closes).** Propose-stage behavior, budget gating, tuple gating,
metering, parse hardening and fail-closed paths are verified on real models
(see the companion evidence document). The judge→applied stage has automated
coverage but no live-session observation yet; the holdout acceptance item
"nonempty accepted projections" is therefore not yet demonstrated end-to-end
on real models. Follow-up: re-run a 5-session slice under a long-lived
process to capture `applied=true` and closing compression numbers.

## Privacy

No credentials, endpoints, prompts, model reasoning content, or user data are
embedded in this document. All quoted metrics are structural counters.
