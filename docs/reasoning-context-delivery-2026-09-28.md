# Kernel reasoning replacement delivery ledger

Issue: [#671](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues/671). Branch: `fix/reasoning-context-contract`. Base dev: `76f5a336ab33777065cd96085af9e8c30093c50e`. Release number remains subject to current tag derivation at promotion time.

| Work item                                     | Owner        | State                                | Evidence / acceptance                                                                                                  |
| --------------------------------------------- | ------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Reconstruct 1.0.50 and current dev behavior   | Astra + Luna | Complete for bounded paths           | Source/tag comparison; source fallback where graph was stale or missing                                                |
| OpenRouter serializer conflict                | Sol          | Complete (mock)                      | Pinned SDK 2.9.0 synthetic cases, injected fetch only                                                                  |
| Kernel replacement implementation             | Astra + Sol  | Complete                             | Shared classifier, paired replacement/provenance, both hosts and all history consumers                                 |
| Independent review                            | Luna + Astra | Complete for changed paths           | Legacy mixed replay, caller enablement and transaction races fixed; final review found no further reproducible blocker |
| Local verification and generated clients      | Sol + Astra  | Passed                               | Fixed Bun 1.3.14; results below                                                                                        |
| Isolated source-runtime live validation       | Sol + Astra  | Passed for configured DeepSeek shape | Proposal, independent judge, durable adoption, reload, actual next-request use and disabled recovery; 24 assertions    |
| OpenRouter real upstream validation           | Sol          | Unavailable                          | Daily free-model quota HTTP 429; mock is not upstream acceptance                                                       |
| Feature PR and current-head CI                | Astra        | Pending                              | Native PR URL, head and terminal checks                                                                                |
| Dev current-head CI                           | Astra        | Pending                              | Merged dev SHA and terminal gates                                                                                      |
| Main promotion and full stable gates          | Luna         | Pending                              | Begin after dev gates; exact main candidate and merged SHA                                                             |
| Stable workflow, assets and installed runtime | Luna         | Pending                              | main dispatch, tag/Latest/assets/digests and separately installed runtime                                              |
| Linked Issue state and final evidence         | Astra        | Pending                              | Native readback required                                                                                               |

## Local verification

- Workspace typecheck: 29/29 packages passed after final product changes.
- Repository lint: 4,836 warnings, zero errors; existing 4,850 cap unchanged. New type assertions and test warnings were corrected after the initial failed run.
- Focused tests: core canonical/adoption/runner 21 passed; opencode distillation and SDK serialization 79 passed; opencode session/adoption/reload 12 passed.
- Full DAG gate: core 93 passed, opencode 727 passed with one existing skip, schema 3 passed, TUI 61 passed. All required coverage floors passed.
- Both generated-client checks and installer boundary (9/9) passed. The first DAG attempt stopped at legitimate unstaged schema output; output was inspected and staged, then the complete gate passed.
- `git diff --check` passed.

## Real runtime evidence

The isolated run began at 2026-09-28 16:40:35 Asia/Shanghai using existing configured `local-proxy-compatible/deepseek` for main and auxiliary calls. It used an empty project, synthetic messages, isolated application directories and existing credential references. Raw wire bodies remain private; no credentials, active user history or tool execution entered this report.

| Request | Role                         | Result                      | Observation                                                    |
| ------- | ---------------------------- | --------------------------- | -------------------------------------------------------------- |
| 001     | Title                        | HTTP 200                    | 893 reported tokens                                            |
| 002     | First main turn              | HTTP 200                    | 2,644 reported tokens; original reasoning source               |
| 003     | Independent proposal         | HTTP 200                    | 5 claims, 32 coverage entries; 10,195 reported tokens          |
| 004     | Independent judge            | HTTP 200                    | 5 support entries; 10,968 reported tokens                      |
| 005     | Second main turn             | HTTP 200                    | Actual outbound used adopted reasoning; 3,156 reported tokens  |
| 006     | Background proposal          | Canceled by planned restart | No completed response, usage or adoption                       |
| 007     | Third turn, feature disabled | HTTP 200                    | Actual outbound used original reasoning; 2,753 reported tokens |

The same canonical part ID persisted a replacement from 617 to 843 characters with `distillation.version=2`, original text and source fingerprint. Metadata was absent for this provider's plain canonical shape. Reload preserved that object. Request 005 used its new `reasoning_content`; request 007 used its original content after disabling. Message counts were 2 → 4 → 6, with no added memory message. Synthetic ledger checkpoints, original result 546, revised result 634 and difference 88 passed independent numeric checks. All 24 evidence assertions passed.

The two completed distillation calls reported 21,163 tokens; three main calls reported 8,553. Request 006 usage is unknown. Increased text length and successful replay are not claims of token savings or improved long-task quality.

Runtime identity: base HEAD above plus unchanged tracked diff SHA-256 `75212e3976e133b8dadbb11e2ffda15d183f152de3bc1abfeca86985af0196a0` and new canonical helper SHA-256 `2907dc060d5f2aef88131527deebdec5d09fdd5bddd782082ade4b9d917fa7b9`. The final continuation-race guard was present before startup. Subsequent ledger edits do not change product code.

Initial OpenRouter testing failed with `free-models-per-day-stealth` before its first successful response and was stopped. That provider's plaintext mirror has pinned-SDK mock coverage; this live run proves the distinct configured DeepSeek shape. Signed, encrypted and unknown carriers remain protected. Standing authorization to use configured QWEN, GLM and DeepSeek models for necessary isolated tests is recorded in `AGENTS.md`.

Main publication and separately installed release-runtime acceptance remain pending. No workflow trigger, local test or mock is treated as release completion.
