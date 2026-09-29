# Reasoning denoising and latency acceptance

## Scope and status

Baseline: stable 1.0.53, source `1adf8b186a5f366eefa40655fb2e354523534225`.
Issues #680 (useful-information denoising) and #681 (avoidable waiting), PR #682 to `main`.
The user requires design, implementation, real latency/quality acceptance, then a stable release. `dev` is retired.

| Work                    | Owner   | Acceptance                                                                                             |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| Design and final review | Astra   | One small-model call, immediate adoption, lifecycle safety                                             |
| Core helper and runtime | Sol     | Batch all eligible parts once; configured small model; cancellation and independent sessions           |
| OpenCode runtime        | Sol     | Dedicated distill entry; no proposal/judge chain; low effort; atomic adoption                          |
| Discovery               | Luna    | Actual configured model and source call chain                                                          |
| Live tests and delivery | Primary | Matched synthetic tests, real database writeback, current-head gates and release artifact verification |

## Root cause and rejected intermediate result

The configured small model is `local-proxy-compatible/deepseek`, with low reasoning effort. The old path asked it for a large claim/provenance proposal and then an independent review; parts were handled serially. A matched synthetic input took **4.19 seconds** with direct cleanup versus **30.24 seconds** through proposal (13.38 seconds) plus review (16.85 seconds). This was primarily extra model work, not a 20-second database transaction.

An intermediate change moved the work behind the foreground response but retained the expensive pipeline. A real source-runtime test returned the primary answer in 1.799 seconds, then adopted reasoning 23.492 seconds later (15.273 seconds proposal + 7.994 seconds review). The user rejected this as a latency solution. That intermediate implementation is not the accepted optimization.

## Final production contract

Completed reasoning → configured small model once → returned replacement text → local structure/source checks → atomic persistence → upstream consumption.

- Single part: plain replacement body; no claim extraction, fixed C labels or category renderer.
- Multiple parts: one request and an index/text envelope, with independent content for each part. Invalid/missing/duplicate indices reject the whole batch.
- Explicit all-noise output allows an empty replacement. Actually empty, truncated or failed output preserves the original.
- No automatic model retries and no second model review. Core retains `small_model` in config and V1 migration. Missing auxiliary models skip instead of falling back to the main model.
- Source identity, original metadata, signed/encrypted protection, stale-turn rejection and disabled-feature replay remain host responsibilities.
- Model cleanup quality is tested offline; local structural validation does not certify semantic fidelity.
- Scheduling is separate from processing time. A foreground response may already have returned; downstream reads after adoption see the replacement. Timing results below measure the organizer and writeback rather than just foreground return.

## Reproducible real-model acceptance

From `packages/opencode`, use pinned Bun 1.3.14 and run `bun run script/reasoning-distillation-live-acceptance.ts` with `DISTILLATION_ACCEPTANCE_CONFIG` pointing at an authorized existing configuration and `DISTILLATION_ACCEPTANCE_OUTPUT` at a private output directory. Credentials remain environment references and are not logged. `DISTILLATION_ACCEPTANCE_CASE` selects a fixture; `DISTILLATION_ACCEPTANCE_REPEATS` sets 1–5 repetitions per case (default 3).

The corpus covers one final conclusion, deduplication, distinct scopes, meaningful rejection, uncertainty, all-noise text, short arithmetic reasoning, long-task continuity and multiple independent parts. Direct baseline order alternates. Long-task follow-up calls are offline acceptance only and are not in the production organizer.

The first single-call full run exposed unwanted correction narrative in two of three one-conclusion repetitions. The prompt was strengthened to remove superseded guesses and their correction narrative without deleting real failures or unresolved constraints. That failed run is preserved locally and is not represented as acceptance.

## Final synthetic results

All **27/27** checks passed (nine cases repeated three times); every organization used exactly one model request. Long-task continuation also retained the execution restrictions and unresolved state. [Machine-readable synthetic evidence](evidence/reasoning-denoise-live.json).

| Case                 | Passes | Organizer model median | Matched direct median |
| -------------------- | -----: | ---------------------: | --------------------: |
| one-conclusion       |    3/3 |                3.144 s |               2.451 s |
| deduplicate          |    3/3 |                2.829 s |                     — |
| different-scopes     |    3/3 |                2.650 s |                     — |
| meaningful-rejection |    3/3 |                2.255 s |                     — |
| unresolved           |    3/3 |                2.724 s |                     — |
| all-noise            |    3/3 |                1.600 s |                     — |
| short-reasoning      |    3/3 |                2.730 s |               2.447 s |
| long-continuity      |    3/3 |                3.706 s |               3.282 s |
| multiple-slots       |    3/3 |                2.608 s |               2.997 s |

Local helper validation plus canonical text replacement was below **0.9 ms** in these samples. This excludes database adoption, measured independently below. These finite samples establish the measured behavior, not a universal semantic guarantee or fixed network latency. The unmodified direct baseline sometimes retains noise and is used only as a timing comparison.

## Actual runtime writeback

An isolated source server uses a temporary HOME/config/database, the existing authorized DeepSeek provider, synthetic input, no user sessions, and no tools. It waits for a persisted adopted part and reads it back through the session API. Only allowlisted timing fields are retained.

First single-call observation: model **2823.016 ms**, database adoption **5.279 ms**, complete organizer **2829.619 ms**, one model call. The approximately 3.081-second polling observation includes the polling interval; it is not the database duration. Three isolated runs all adopted exactly one model result. Model / adoption / complete times were 2823.016 / 5.279 / 2829.619 ms, 2989.668 / 4.498 / 2995.463 ms and 2372.925 / 3.752 / 2377.790 ms. Total local overhead was 4.864–6.602 ms. [Allowlisted runtime evidence](evidence/reasoning-denoise-runtime.json). The first run preceded the final semantic prompt refinement; the last two used the accepted prompt.

## Regression checks

- Astra final source review accepts the single-call implementation, including actual HTTP effort precedence and request-local retry suppression.
- Full core suite: **1,463 passed**, zero failures.
- Full LLM package suite: **312 passed**, 30 skipped, zero failures. New tests prove HTTP 503 sends one request with the auxiliary override and subsequent normal requests retain their default retry behavior.
- OpenCode LLM file: **59 passed**; prompt integration: **114 passed**, one skipped.
- DAG core behavior and coverage gate: all critical floors passed.

The full OpenCode run exposed a separate immediate-PTY-exit race already observed in the prior full run. Issue #683 tracks preserving and replaying the real exit event to late subscribers in the existing bun-pty dependency. This is a real lifecycle repair with separate regression coverage, not an increased test timeout. The original immediate `exit 4` HTTP fixture remains unchanged. The initial full OpenCode run had 4,892 passes, 30 skips, one todo and this one failure; a fresh targeted run after the dependency fix verifies the preserved lifecycle assertion. Current-head native full CI remains required.

## Verification and delivery

Final workspace typecheck passed 29/29 packages; lint reported 4,848 existing/total warnings and zero errors, below the unchanged 4,850 cap. Astra accepted both the single-call implementation and the isolated PTY patch. Core PTY tests passed 8/8 and the original HTTP PTY file passed 4/4 after the fix. Client and SDK generators were run after the core config change; no generated contract changes resulted. Local regressions, Astra final review, current-head native checks and release artifact verification are distinct gates. Publishing is pending until those gates complete. Prior failed/cancelled CI runs are not current acceptance.

### Dependency patch installation check

The first native run of `a28853fac3` failed in PTY tests after a clean dependency install: an incorrectly formatted import hunk in the bun-pty patch removed the neighboring `node:path` import. An isolated Bun 1.3.14 installation reproduced this artifact-only defect. The patch was regenerated from the unmodified package with standard unified-diff ranges, removing the unnecessary import change. A second fresh directory with an independent cache preserved the imports and passed actual exit-code/replay checks plus the late-subscriber regression. Native gates are rerun on the corrected commit; the failed run is not acceptance.

## 2026-09-29 local preview acceptance

The preview prompt now removes obsolete guesses, correction narration and empty filler while retaining valid state, English text and calculation results. The organizer still sends all eligible slots for this turn in one JSON request. The local DeepSeek configuration explicitly declares `variants.none`; runtime sends `none` only when the model declares that variant and otherwise falls back to `low`.

Direct API replay of the historical four-slot input (4,860 source characters; 5,482 with the shared prompt) produced valid four-slot JSON in both modes: `low` took 29.37 s and emitted 16,847 hidden reasoning characters, while `none` took 2.43 s and emitted none. This is a sequential direct API replay, not a full TUI end-to-end result. Latest synthetic live acceptance passed **27/27** checks (nine cases × three repetitions), with zero hidden reasoning; `modelMs` median was **830.2 ms** (range **574.7–1,097.0 ms**). The first prompt version passed 26/27 under `none` because it dropped an arithmetic result; the corrected prompt restored it.

Older real TUI logs show four-slot `low` calls taking 15–27 s in `modelMs`, nearly all of `totalMs`; `adoptMs` was 6–12 ms. Normal TUI event queueing was at most 16 ms. New `prepare` / `queue` / `end_to_end_ms` logs measure their named phases and do not include the remainder of the main reply, Stop hooks or TUI rendering. CI/CD was cancelled; this preview is not evidence of completed CI or a stable release.

An isolated release-binary run used a separate config/database and a synthetic arithmetic question; the main answer returned, then the reasoning was successfully persisted and adopted. The second run measured `prepare_ms=0.619`, `queue_ms=5.635`, `model_ms=621.249`, `adopt_ms=5.807` and `end_to_end_ms=635.345`. HTTP polling observed adoption 1,042 ms after the answer, at 500 ms polling granularity; this is not writeback duration or TUI frame time. No real user session or content was used. This does not establish full TUI end-to-end acceptance.
