# Reasoning denoising and latency acceptance

## Scope and owners

Baseline: stable 1.0.53, source `1adf8b186a5f366eefa40655fb2e354523534225`.
Work: Issues #680 (useful-information denoising) and #681 (avoidable waiting).
The owner requests a stable release after implementation, validation and native CI acceptance.

| Task                                             | Owner              | Acceptance                                                                                              | Status  |
| ------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------- | ------- |
| Trace actual model/config/runtime                | Primary + Luna     | Configured DeepSeek identified; runtime and stage boundaries verified                                   | Done    |
| Shared denoising semantics and dynamic rendering | Sol content worker | Remove redundant/abandoned reasoning; preserve meaningful constraints and uncertainty; allow 0..N items | Done    |
| Foreground scheduling and per-stage timing       | Sol latency worker | First completed turn returns without waiting; background safety remains covered                         | Done    |
| Live matched-input acceptance                    | Primary            | Actual DeepSeek transport, independent review, accepted output and elapsed times                        | Done    |
| Review and regression gates                      | Primary + Astra    | Required local tests/typechecks/lint and review findings resolved                                       | Done    |
| PR and stable release                            | Primary            | Current-head native gates, main merge, release artifacts and installed candidate verification           | Pending |

## Verified baseline

- Global configuration explicitly selects `local-proxy-compatible/deepseek` as `small_model`.
- The 1.0.53 AI SDK adapter requests `reasoningEffort: low`, no automatic retries, and a 30-second timeout per call.
- Completed turns select eligible reasoning from the current user turn. The first scheduling submission waits for completion; later submissions run under the service scope.
- Each eligible slot may require sequential proposal and independent review. Multiple slots are processed serially. The configured model names are not the established cause of the delay.
- Existing local logs contain 34.9 seconds for one slot and 84.4 seconds for three slots with a timeout. These are accumulated auxiliary timings, not per-request durations or a matched-input benchmark.
- The organizer over-preserves rejected thoughts; the renderer exposes internal claim IDs and provenance-related labels. No fixed four-claim constraint exists in the parser.

## Live acceptance procedure

Run the opt-in script from `packages/opencode` using pinned Bun 1.3.14. Set `DISTILLATION_ACCEPTANCE_CONFIG` to an existing authorized configuration and `DISTILLATION_ACCEPTANCE_OUTPUT` to a private local artifact directory. Existing environment credential references must resolve; they are never printed or written. `DISTILLATION_ACCEPTANCE_CASE` optionally selects one synthetic fixture.

The harness compares complete direct-model output with the production proposal/review/validation pipeline using the same model, endpoint, effort and output budget. It captures outbound model/effort, timing, synthetic outputs, usage and accepted canonical replacement. It does not access user conversations. Local model SDK calls plus pure pipeline acceptance are distinct from installed-runtime session/TUI acceptance.

## Results

The revised synthetic run passed all six cases. See [machine-readable results](evidence/reasoning-denoise-live.json). Every observed wire request used model `deepseek`, effort `low`, no automatic retries and a 24,576-token ceiling; credentials and endpoints are absent from the report.

| Case                 | Accepted claims | Proposal + review | Result |
| -------------------- | --------------: | ----------------: | ------ |
| one-conclusion       |               1 |           30.24 s | Pass   |
| deduplicate          |               1 |           25.08 s | Pass   |
| different-scopes     |               6 |           17.86 s | Pass   |
| meaningful-rejection |               1 |           26.76 s | Pass   |
| unresolved           |               1 |           13.47 s | Pass   |
| all-noise            |               0 |            4.61 s | Pass   |

The matched direct call completed in 4.19 seconds. Complete proposal + review took 30.24 seconds on that same input. These are single samples with variable model reasoning cost; smaller requests do not establish a statistical wall-clock speedup. The initial denoising run failed this case by preserving an abandoned value. The shared organizer/reviewer contract was corrected, and the entire six-case corpus was rerun successfully.

The single-conclusion review request decreased from 8,218 to 5,369 characters despite the strengthened semantic instructions. The different-scopes case decreased from 10,442 to 6,452 characters. All claim content, evidence and exact source ranges remain available. Per-stage model reasoning sizes are recorded so upstream reasoning cost is not confused with local processing.

Foreground non-blocking behavior is established by scheduler tests using deferred proposal/review completion, not inferred from model latency. Both adoption bridges are tested with empty accepted text and replay of original content when disabled. A review finding caught the initially missed opencode adoption guard; it was repaired before acceptance.

Local verification: core reasoning/context-folding: 178 passed; OpenCode reasoning/canonical replay and release contracts: 115 passed; workspace typecheck: 29/29 passed; lint: 0 errors and below the unchanged 4,850-warning cap. The DAG behavior/coverage gate passed all critical floors. Astra final source review accepted after the empty-adoption fix. Native CI and release remain separate delivery gates.

## Runtime preflight

A fully isolated source-runtime server used the configured DeepSeek provider for a synthetic inventory calculation. The foreground answer returned in 1.799 seconds with no adopted reasoning. The same session received its adopted reasoning 23.492 seconds later, after proposal (15.273 seconds) and review (7.994 seconds). Both auxiliary calls requested `low`; the runtime reported `applied=true`. The accepted text preserved the intermediate arithmetic and final result 83. It expanded an already concise English source into Chinese structured statements, so this is evidence of asynchronous adoption and fidelity, not of compression quality.

The first full native CI run exposed a core-runner integration test that still asserted synchronous first-turn completion. The corrected test explicitly holds the auxiliary work, verifies that the foreground returns, then observes adoption for both slots and their use in later turns. All 81 core-runner integration tests and the full 1,454-test core suite passed after the correction. The required native checks remain mandatory.

## Delivery

PR #682 targets `main` and closes Issues #680 and #681. Current-head CI, stable publication and downloaded binary acceptance are pending. No release is claimed by the local test results.
