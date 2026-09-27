# Reasoning replay upstream verification — 2026-09-28

This is a bounded synthetic compatibility test against the configured `local-proxy-compatible/glm-flash` endpoint. No repository prompts, user session content, or credentials were included in the evidence.

The upstream first generated a reasoning-bearing `audit_echo(value=7)` tool call. The actual host `runDistillationCycle` then called the same upstream separately for organization and fidelity review. The resulting projection replaced the assistant's `reasoning_content`, preserving the original tool-call ID, arguments, tool result and ordering. A real continuation request returned `RESULT=7`. Rebuilding the request from original history on an idle cycle reused the validated candidate without further auxiliary calls.

| Check                        | Result                                   |
| ---------------------------- | ---------------------------------------- |
| Original reasoning           | 973 characters                           |
| Organized reasoning          | 1133 characters, different from original |
| Auxiliary calls              | 2: proposal and independent review       |
| Retention review             | supported                                |
| Projection                   | applied                                  |
| Next-cycle reuse             | applied; no additional auxiliary call    |
| Actual upstream continuation | `RESULT=7`                               |
| Original history             | unchanged                                |

Original SHA-256: `ae15d86ccdffb252ce10ab61ccb066919f18ae4ea6999869efc713fe7117e91d`.

Projected SHA-256: `56f823ef841cbd9a4bd240f9d9289405ade1e28412f26118e78622c343f3f138`.

The organized representation is longer because it explicitly records scope, uncertainty and rejected alternatives. This validates organization rather than a target compression ratio.

## Failure cases retained

- A 10-character source was preserved verbatim: now reported as `unchanged-reasoning`, not successful replacement.
- The first rich-source proposal had gaps in model-counted offsets and inconsistent preserved ranges: rejected before sending. Program-generated UTF-16 ranges fixed this on the same frozen source without weakening coverage checks.
- Unknown protocol compatibility, signed or opaque reasoning, changed source evidence, malformed output, failed review and capacity overflow retain the original request.

## Evidence boundary

This test proves the host projection and one real configured upstream's continuation behavior. Independent controlled transport tests assert final AI SDK and Native serialization. It is not a blanket compatibility authorization for other endpoints, variants, adapters or options, nor proof of installed TUI behavior. Packaged terminal, current-head CI and stable release acceptance remain separate gates in the delivery ledger. Derived cache state remains process-local and is rebuilt after restart; persisted original reasoning remains the source of truth.

## Compiled runtime and max variant

The compiled TUI sent a 225-character structured reasoning field through the actual SDK after two auxiliary calls, then received RESULT=7 after the read-tool result. PTY reload/resize/exit verification passed with zero SDK-warning bytes and exit 0. A separate real replay with `reasoning_effort=max` and `clear_thinking=false` also returned RESULT=7. One independently generated max-variant proposal was invalid and fell back to the original; the runtime now explicitly reports `invalid-proposal` instead of an ambiguous `none` skip reason. This failure is retained as a failure, not counted as replacement acceptance.

## Final packaged max run after contract and temporal-input repairs

Session `ses_fe5f1be36b53wln0uoOV098dyy` (2026-09-27T18:25:03Z) used the actual compiled CLI with `reasoning_effort=max` and `clear_thinking=false`. The first tool continuation completed one organizer and one independent judge call, applied a 349-character organized `reasoning_content`, and the real upstream returned `RESULT=7` after reading the synthetic fixture. Final wire SHA-256: `fe469c21c7de3057c3b367b2f17afa39b85ad4cf16b4657f33a545b18a2404ed`.

Captured earlier failures exposed two concrete mismatches: an output contract permitting empty source bindings, and a prompt offering later tool calls as evidence for earlier reasoning. Both were fixed without weakening source coverage, temporal validation, or semantic review. Invalid or unfaithful model output still keeps the original reasoning; this successful bounded run does not assert universal model reliability.
