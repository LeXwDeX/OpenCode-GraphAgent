# Retired Branch Reconciliation

Issue: #693. Audit baseline: main `78d7539656` (GraphAgent 1.0.57).

## Disposition

| Origin branch                                | Evidence                                                                                                                                                        | Disposition                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `docs/reasoning-distillation-chinese-output` | `6e160bb9d8` is patch-equivalent to main ancestor `72dd646009`.                                                                                                 | Retire; retain the Chinese-output requirement in the current organizer. |
| `feat/reasoning-distillation-core`           | All 14 commits through `af7d2ed236` are patch-equivalent to main ancestors. Later changes replace the two-call cycle with single-pass organization.             | Retire; do not replay the old architecture.                             |
| `fix/context-review-repairs`                 | `f39663effd` is an ancestor of main. Later reasoning changes extend its context-accounting and fidelity repairs.                                                | Retire; no missing branch change identified.                            |
| `fix/hooks-compaction-release`               | `610870c699` is superseded by `099a5e7d83` in PR #690. Nineteen shared files match; the remaining four contain later retry-control, test and lint improvements. | Retire; preserve the reviewed main implementation.                      |

Ancestry and patch equivalence establish delivery history, not current correctness.
Current source was inspected separately because the primary checkout and its graph
index predate the release. The live organizer is shared by both runtime hosts;
legacy propose/judge machinery remains for historical tests and is not restored.

## Corrections

- The Chinese-output contract survived in the design document and legacy prompts,
  but the shared single-pass organizer lacked an explicit language instruction.
  Its output contract now requests Chinese prose and unchanged technical literals.
  This is a model instruction, not a language or semantic-fidelity validator.
- Hook creation text incorrectly named 27 events although the loader supports 26.
- Hook migration text claimed unknown events warn, although the loader silently
  skips them. Documentation now describes that behavior without adding logging.
- Matcher documentation now distinguishes exact names from regex patterns.

## Prompt Revision Evidence

The runtime output contract owns the language correction; hook skill and command
text own the event and matcher facts. No new global agent rule is needed.
Single-slot and batch prompt tests check the language instruction and literal
preservation requirement. They do not prove every model follows the instruction.
Existing organizer tests retain failure, truncation and original-preservation checks.
Synthetic live probes using the configured `local-proxy-compatible/glm-flash`
passed for one English slot and a two-slot batch. Each organization made one
request; Chinese prose, the specified technical literals and the pending execution
state were retained. Only check metadata was recorded, not credentials or model
response bodies. These were source-helper probes, not installed-binary or full
database-writeback acceptance, and do not guarantee model-wide compliance.
If live models violate the language instruction, capture synthetic evidence before
changing the contract again rather than adding untested semantic claims.

## Preserved Work

`codex/oc-path-priority` has an unmerged installer PATH repair. The unique integration
and acceptance artifacts on `feat/unified-predev-acceptance` are also unmerged.
Neither is part of this four-branch reconciliation. The primary checkout's dirty
files are preserved; cleaning branch references does not synchronize that checkout.
