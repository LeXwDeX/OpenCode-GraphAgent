# Reasoning organizer coverage contract — release acceptance follow-up

## Scope and responsibility

The organizer proposes structured reasoning; the existing coverage validator and independent judge decide whether the actual outgoing request may use it. This revision changes the organizer output contract and binds host-issued source aliases before the unchanged parsers and fidelity gates.

## Component map and assessment

Both adapters already define the organizer role, untrusted input boundary, source coordinates, output shape and independent review. Coverage wording was duplicated and incomplete: it required coverage/preserve entries to appear in `preserved`, but omitted the inverse requirement and the retained, different-span requirement for merge witnesses. Runtime checks were correct.

## Observed failure patterns

- P1, duplicate preservation: the formal candidate at main `3e079729232a20f1e830afe63afc4b71887e6ccc` produced claims with `keep` coverage while also putting the same source into `preserved`. `validateCoverage` rejected the unmatched preserved span. The read/tool task still returned `RESULT=7` using original reasoning; no application success was claimed.
- P2, self-witness: a second fresh GLM Flash max session emitted a `merge` entry whose witness equaled its source. The existing self-witness guard rejected it. Its scope also contained organizer-only non-execution wording, which is not part of source reasoning.
- P3, adapter drift: the host prompt listed coverage actions but the CoreRunner prompt did not state their executable relationships. Both consume the same validator.

The two real responses are retained in the private release acceptance bundle (`response-36.json` and `response-40.json`), with synthetic test data only. The new validator regression cases reproduce their structural errors without requiring a paid model or embedding session-specific identifiers.

## chg-1 — one shared coverage output contract

- Failure evidence: P1/P2 and the existing `validateCoverage` branches in `claims.ts`.
- Cause: one-way preservation wording and an underspecified merge witness let the model infer combinations that the runtime cannot accept.
- Change: place one contract next to the shared source-range renderer; both adapters include it. Require a non-overlapping complete partition, mutually exclusive keep/preserve actions, exact preserved/preserve correspondence, and a different retained merge witness. Scope describes source reasoning rather than the organizer's own permissions.
- Prediction: fresh calls for the same short read scenario stop emitting these two malformed coverage shapes; valid proposals still pass independent review and appear in actual `reasoning_content`.
- Risk: a longer contract may consume extra input tokens or bias organizers toward verbatim preservation. No validator, call budget, retention verdict, transport capability or fallback is relaxed.
- Component layer: output contract. No root agent prompt, provider credential, system permission or persistent memory is changed.

## chg-2 — bind source aliases instead of model-generated offsets

- Failure evidence: after chg-1, a fresh compiled call stopped emitting duplicate preservation and self-witnesses but invented offsets; its `keep` range `[0,15)` was outside the referenced claim's `[15,129)` source. The unchanged validator rejected it as `invalid-reference` (`response-44.json`). The same response copied organizer-only non-execution wording into scope.
- Cause: asking a language model to produce precise offsets and repeated message/part identities still exposed unnecessary arithmetic and transcription failure points. The organizer preamble also supplied non-execution wording that could be mistaken for source scope.
- Change: the host assigns each exact source range an ID such as `R0.0`; both adapters bind returned IDs to original message/part identities and UTF-16 offsets before parsing. Unknown IDs stay invalid. Existing raw references remain supported by the defensive parser. Use a valid JSON format example and remove the organizer-only non-execution narrative from the preamble. The existing untrusted-data boundary, tool-free auxiliary calls and independent judge remain.
- Prediction: the same real scenario can produce a structurally valid proposal without model-counted offsets; valid output reaches independent review and actual wire replacement. Malformed, unknown or semantically altered references still fail closed.
- Risk: alias numbering must remain identical between rendering and binding, including blank lines, emoji and multiple slots. Shared range generation and real adapter regression tests cover those boundaries; original model output is not mutated.
- Component layer: adapter input/output binding, replacing prompt-only arithmetic requirements rather than adding another counting instruction.

## Falsification and acceptance

- Replay the two malformed shapes through the existing validator: both must remain rejected, while their valid counterparts pass.
- Verify both adapters include the shared contract and retain their evidence ordering constraints.
- Run targeted core/host tests and workspace lint/typecheck.
- Use real GLM Flash max calls and the compiled binary; require `applied=true`, independent review, changed wire reasoning and successful continuation. Do not count a task answer alone as distillation acceptance.
- Rebuild through the formal release workflow after current-head CI; compare candidate digests and repeat TUI/runtime acceptance before publication.
- If alias binding or semantic retention fails, reassess chg-2 and the captured evidence rather than accumulating further instructions. Do not normalize a rejected candidate into acceptance or weaken retention checks.

Validation results are recorded in the release ledger after execution. Stable publication remains tracked by Issue #661; this correction is Issue #663.

## Local validation of chg-2 (2026-09-28)

- Pinned Bun 1.3.14: core full suite 1433 passed; host reasoning/LLM suite 125 passed; all 29 workspace typechecks passed. Lint: 4846 warnings, 0 errors, unchanged from the accepted baseline.
- Three fresh compiled GLM Flash max sessions applied independently reviewed reasoning and returned `RESULT=7`: two through the recording relay, one directly against the configured upstream. The direct probe used the user's model limits and max options with credential references, without changing the user's global configuration.
- The first new final request contained 281 characters of organized reasoning instead of the original 238 characters. Its `reasoning_content` SHA-256 was `9a7bef0e2a5b053ab17ad706cbd768e0f78435544481e1b136829765581fab50`; `reasoning_effort=max` and `clear_thinking=false` were present. Organization may expand the text; acceptance does not require a compression ratio.
- Compiled PTY acceptance: exit 0, result visible after reload and resize, split capability reply consumed, no leaked `4d73` fragment and no AI SDK warning on the terminal.
- These observations validate this correction's local runtime paths, not arbitrary model reliability or the next formal release artifact. The previous formal candidate remains held. Exact-head CI and a new formal candidate are still required by #661.
