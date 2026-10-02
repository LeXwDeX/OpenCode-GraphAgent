# Goal Judge Recovery

Issue: #691. Evidence collected on 2026-10-02 against main `5927e22d11`.

## Findings

The internal judge asks for a small model using the default provider as a hint.
An explicit `small_model` can select a different provider, and a plugin can
override selection; otherwise it falls back to the default model. It does not
look up an agent or model named `judge`, nor does it necessarily inherit the
conversational model. A synthetic live probe of the
configured compatible provider selected `local-proxy-compatible/glm-flash`.

The previous request allowed only 200 output tokens, while the subgoal prompt
requested concrete evidence for every criterion. Reasoning can consume that
same output budget. The production path discarded finish reason and usage and
retained only text; historical empty and 267-character responses therefore
cannot be conclusively attributed to a specific upstream cause.

Synthetic probes sent no user conversation, repository contents or private
prompts. Recorded metadata only:

| Prompt                   | Output limit | Finish | Output tokens | Reasoning tokens | Text characters | Parse           |
| ------------------------ | -----------: | ------ | ------------: | ---------------: | --------------: | --------------- |
| Previous, seven subgoals |          200 | length |           200 |              145 |             255 | incomplete JSON |
| Same previous prompt     |         1024 | stop   |           265 |              192 |             303 | valid continue  |
| Revised concise prompt   |         1024 | stop   |           120 |               88 |             146 | valid continue  |

This reproduces a budget-induced incomplete response, not the exact historical
267-character response. A separate simple probe succeeded even at 200 tokens;
the provider is not universally failing, and the historical empty responses
remain unexplained.

## Recovery And Diagnostics

Each evaluation now permits at most two calls against the same goal and response,
with output limits of 1024 and 2048 tokens and a 30-second deadline per attempt.
SDK transport retries are disabled for these calls so the request count is
bounded. The prompt asks the judge to verify all subgoals but return one concise
reason. A valid verdict stops retries immediately.

Logs record resolved provider/model, session, attempt, output limit, deadline,
finish reason, token counts, text length and parser failure category. Raw
prompts, response text, headers, credentials and exception messages are not
logged. `truncated-json` remains a structural suspicion; `finish_reason=length`
provides separate evidence of output-budget exhaustion.

Three consecutively failed evaluations still pause the goal. Failures remain
budget-neutral, explaining a persistent `0/20` counter when no valid continue
verdict has been committed. Resume preserves goal identity, criteria, progress
and total budget, resetting the failure streak rather than granting fresh turns.

The regression suite covers same-boundary recovery, bounded persistent failure,
valid/fenced/embedded JSON, wrong shapes, privacy-safe metadata and the complete
failure-pause-resume-valid-continue counter sequence. Historical upstream
response loss cannot be reconstructed from logs that never retained metadata.
