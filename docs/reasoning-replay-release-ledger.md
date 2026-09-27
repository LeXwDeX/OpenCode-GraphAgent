# Reasoning replay and terminal reliability delivery

Base: `503d84a5e350d0da4a3c08f70bc088a935350709` (dev), matching 1.0.49 runtime source.
Branch: `fix/reasoning-replay-tui-release`. Owner authorization: implement through main/release, then retire the defective 1.0.49 Release while retaining its tag.

| Work                                                                      | Issue | State        | Acceptance                                                                                                                       |
| ------------------------------------------------------------------------- | ----- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| First-turn / every-three-turn reasoning preparation and continuous replay | #656  | Implementing | First settled reasoning; turns 1/4/7; independent review; real final-wire substitution and continued execution; fail-safe replay |
| Worker diagnostics and TUI corruption                                     | #657  | Implementing | Worker startup/runtime warnings stay in logs; packaged PTY model/tool/resize/exit smoke                                          |
| Compatible AI SDK maintenance                                             | #658  | Implementing | ai 6.0.290 + openai-compatible 2.0.78; mature publication dates; protocol regression and full gates                              |
| OpenTUI upgrade decision                                                  | #659  | Evaluating   | Current 0.4.3 versus 0.5.12; matched core/solid/keymap; type and native terminal tests                                           |

## Baseline evidence

- Bun 1.3.14: core reasoning/config 104 pass; host reasoning/transport/provider conversion 428 pass; LLM/native/recorded 68 pass, 1 opt-in skip.
- Additional continuity regression fails: accepted reasoning ceases to apply after a new unrelated user message; retries remain semantic-review-required with one propose and one judge already consumed.
- Existing real-model holdout documents 0/20 applied sessions. Proposal generation alone is not final-wire acceptance.
- Current local GLM config has no reasoning compatibility records; lowering the cadence gate alone cannot enable rewriting.
- AI SDK 6.0.288 directly emits the system-message warning via console.warn; the server worker had no console redirection.

## Remaining delivery gates

- Complete implementation and focused regression, then package typechecks, lint, DAG gate and required integration suites.
- Verify actual compatible upstream replay using an authorized test endpoint; never substitute mock transport evidence for upstream acceptance.
- Current-head PR CI/review and merge to dev; stable promotion PR with full checks to main.
- Release build, artifact integrity and installed runtime acceptance; only then retire GitHub Release graphagent-v1.0.49.

## AHE evolve summary: organizer source binding

Scope: the organizer input/output contract in `session/reasoning-distillation.ts`. Role and tool restrictions already exist; the missing surface is a machine-generated source-coordinate map.

- P1: A real GLM proposal left gaps and mismatched preserve entries, producing `retention-contract-violated` before independent review. The model was counting offsets in an unannotated 973-character source.
- P2: The same proposal introduced the organizer's lack of tool permissions as a source-agent state claim. These are different actors.
- chg-1: Replace unannotated source rendering with lossless JSON line ranges and their program-computed UTF-16 offsets. State the exact contiguous coverage contract. Prediction: the same source passes structural coverage without weakening the validator. Risk: prompt overhead increases for many short lines; the existing input admission bound remains.
- chg-2: State once in the source-binding contract that organizer permissions are not source-agent state. Prediction: claims cease adding this unsupported statement; the independent judge must still reject invented facts.
- Falsification: rerun the saved synthetic source, inspect coverage and judge, then verify changed final wire reasoning plus continued tool execution. Roll back the corresponding prompt change if its prediction fails; do not count a preserved original as an applied rewrite.

## Local verification checkpoint

- Pinned Bun 1.3.14; complete Turbo test run: all 8 tasks passed. OpenCode: 4868 passed, 30 skipped, 1 todo, 52 snapshots; Core: 1426 passed; app: 453 unit + 17 script tests; UI: 4; session UI: 54. Subsequent targeted tests cover the final bounded changes.
- Final Core reasoning/config regressions: 106 passed. Host reasoning lifecycle: 73 passed. LLM entrypoint and final-wire transport tests passed; worker startup/runtime warning capture passed.
- All 29 workspace typecheck tasks passed. Lint: 4846 warnings, 0 errors, below the unchanged 4850 ceiling; removed unsafe narrowing in the touched Core Runner parser.
- DAG critical behavior/coverage gate passed; installer boundary 9 passed; config assistant Go tests passed.
- HttpAPI exerciser: all three configured runs each 234 passed, zero failures, skips or missing scenarios.
- OpenTUI native TUI suite: 272 passed, 1 skipped, 8 snapshots. Solid singleton resolution fixed both plugin keymap types and SolidStart event augmentation; no application type casts added.
- Real configured GLM replay: see `reasoning-replay-upstream-evidence-2026-09-28.md`. Compiled TUI also emitted an actually changed structured `reasoning_content` (225 characters) in the final upstream tool-continuation request after proposal + judge; the original source remains stored.
- Packaged PTY acceptance passed: initial real model/tool flow, 198×54 → 130×40 → 198×54 resize, restored session with RESULT=7 visible, zero SDK warning bytes, exit 0. The harness sends SIGWINCH to its detached child; merely resizing the PTY does not deliver a foreground-process signal in that setup. Development-version update prompts are disabled in the isolated config.

Core Runner has an independent adapter: its real-user cadence, source-prefix evidence, synchronous preparation, provider-body capacity recheck and model-review provenance were updated and tested as well. Legacy inputs without a user-turn boundary retain capacity-triggered behavior.

## Forge checkpoint

PR #660 targets dev. Additional max-variant protocol replay (`reasoning_effort=max`, `clear_thinking=false`) accepted the independently reviewed replacement and returned RESULT=7. A separate max-variant organizer response was invalid and safely kept the original; this exposed misleading `skip_reason=none`, now corrected to `invalid-proposal` with regression coverage. Model-generated output is never guaranteed to pass fidelity gates.

## Final real-model correction: organizer contract and temporal evidence

- chg-3: The organizer contract incorrectly allowed an empty `sources` array even though the parser requires a source span. A captured real GLM response followed that instruction and added an E-only claim. Require nonempty R bindings, keep `evidence: []` legal, and constrain E to checking R claims. The same saved input then produced a structurally valid candidate.
- chg-4: The earlier untrusted-data preamble leaked the organizer's restrictions into claims about the source agent. Replace repeated permission narration with one data-boundary contract. The saved-input rerun no longer generated those organizer-state claims; parsers and independent fidelity gates remain unchanged.
- chg-5: A packaged max run cited a tool call occurring after the source reasoning, correctly rejected as future evidence. Both adapters now render only earlier tool evidence into propose/judge prompts, using ordered persisted references rather than lexicographic IDs. Preserve the full inventory for validation. Regressions cover prior evidence retained and later evidence excluded.
- Final packaged max run: session `ses_fe5f1be36b53wln0uoOV098dyy`, proposal + independent judge, `applied=true`, actual final `reasoning_content` length 349, upstream continuation `RESULT=7`. Captured wire SHA-256: `fe469c21c7de3057c3b367b2f17afa39b85ad4cf16b4657f33a545b18a2404ed`. No original-history mutation.
- Follow-up host/LLM regressions: 123 passed. Core Runner: 11 passed. These bounded changes supersede the previous PR head and require a fresh current-head CI result.
