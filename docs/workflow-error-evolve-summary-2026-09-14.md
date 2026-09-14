# Workflow system error recovery and reporting

## Scope and evidence

A reported Web App planning conversation saved a valid draft but environment validation returned `model.unavailable` for all four nodes. No start call or durable workflow existed. The parent received the diagnostics but did not explain them; the TUI displayed only `workflow`. Local tier configuration referenced a model ID absent from the provider catalog.

## Component map and assessment

Model selection already fails closed and preserves configured priority. Validation returns diagnostics as a completed tool result. The TUI's success filter hides all completed tool parts when details are disabled; generic output is independently hidden by default. Start separately asked a question before returning its missing-model result. The missing contract belongs in tool failure responses, not a new global system prompt.

## Failure modes

- P1: a completed tool call was confused with successful workflow admission; structured failure disappeared in the TUI.
- P2: diagnostics reached the parent without a bounded recovery/escalation contract; the parent stopped silently.
- P3: start prompted immediately instead of allowing authorized recovery first.

## Changes and falsifiable predictions

### chg-1: failure-response contract

Evidence: P2 and P3. Cause: validate and start had inconsistent failure handling. Add one shared recovery contract to validation and draft failures and rejected mutations; missing-model start returns a blocked result without creating events or asking a question. At most two relevant, authorized, reversible recovery attempts are permitted. Unchanged retries and bypassing model/permission constraints are forbidden. When safe recovery is unavailable or exhausted, the parent must report the cause, attempted recovery, actual task state and choices, then await the user.

Owner: tool error responses. Prediction: the parent diagnoses a missing model, performs only allowed recovery, and explains unresolved failure. Risk: this is a model-facing instruction, not a persisted retry counter or a guarantee of model compliance. No automatic model fallback has been added.

### chg-2: presentation of blocked results

Evidence: P1. Cause: completed status hid semantic failure. Add blocked metadata and a TUI presentation policy that bypasses both visibility toggles, with the diagnostic above collapsible output. Recognize legacy workflow validation JSON so existing history can show the failure after upgrading the application.

Owner: runtime result metadata and TUI presentation. Prediction: missing-model diagnostics remain visible even when tool details and generic output are hidden; successful results retain the existing behavior. Risk: very large diagnostics may occupy extra screen space; details remain collapsible.

## Verification and falsification

Focused workflow tests cover no question/no durable events on rejected start, structured diagnostics and recovery budget, and metadata on failed validation. TUI tests cover historical failure, new blocked results and unchanged successful-result visibility. Package typechecks validate integration.

Verified on the local patch: 78 workflow/schema tests passed; 20 TUI tests passed with 8 unchanged snapshots; both opencode and tui package typechecks passed; `git diff --check` passed. The first TUI snapshot attempt could not open snapshot files inside the sandbox; the identical command passed with approved filesystem access and no baseline update.

The local DAG configuration changed concurrently from the missing `deepseek-v4-flash` ID to the registered `deepseek` ID. A compare-before-write check stopped this task from overwriting that change; this task did not modify the local model configuration.

The model's actual recovery/reporting behavior and a running installed TUI still require an end-to-end replay after deploying the patch. If the parent still stops silently, reject the behavioral prediction in chg-1 and investigate the session continuation boundary instead of strengthening the same prompt. If successful tools become permanently visible, revert chg-2's visibility policy.

Remote duplicate lookup was not completed: automatic approval review rejected sending the internal bug specification to GitHub without explicit external-write/lookup authorization. No Issue, PR, merge, publication or installed-binary replacement was performed.


## Real session rendering regression

Two additional tests mount the production Session component with the existing provider-stack fixture and fake SDK responses. With both `tool_details_visibility` and `generic_tool_output_visibility` disabled, captured terminal frames contain `workflow: blocked`, `model.unavailable`, and the failure reason for both legacy validation JSON and new blocked-start metadata. Both passed alongside the four existing event-cleanup tests. This proves rendering in the local test runtime; it does not replace deployed release acceptance or live model behavior replay.

The task was subsequently moved into the correct YC_OPENCODE_DAG project and the user reaffirmed delivery authorization. Remote SpecGit inspection was still rejected by automatic approval review before process execution, specifically requiring approval of the exact payload and destination. Local product work remains reviewable; native Issue/PR association, current-head CI, test prerelease and installed acceptance remain incomplete.


## Native delivery

SpecGit Issue #599 tracks this repair. Explicit stable-release authorization resolved the approval blocker. Delivery uses an isolated fix/workflow-blocked-errors worktree, dev integration and test prerelease before main promotion. Current local workspace typecheck: 29 packages passed. Release and installed acceptance evidence will be recorded separately.
