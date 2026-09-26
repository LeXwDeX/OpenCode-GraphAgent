# AI SDK and reasoning protocol compatibility review (2026-09-26)

Issue: [#638](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues/638)

## Decision

Keep the application on the maintained AI SDK 6 provider ABI and update every directly pinned package to the newest release that was at least three days old at the implementation cutoff (`2026-09-23T03:00:00Z`). Do not ship the attempted AI SDK 7 migration in this change.

The AI SDK 7 trial reached dependency installation but failed type checking at the provider boundary: the repository's custom GitHub Copilot models and gateway integration implement `LanguageModelV3`, while current gateway packages return `LanguageModelV4`. AI SDK 7 also raises the runtime floor to Node 22, is ESM-only, and changes stream callbacks, usage semantics, message fields, and provider content types. Those are product-wide migrations rather than a safe dependency refresh. The upstream OpenCode `dev` branch also remained on AI SDK 6 when checked. The AI SDK 7 migration remains an explicit follow-up blocker; this delivery does not claim the newest major.

The selected AI SDK 6 stack already parses OpenAI-compatible `reasoning_content` for Chat Completions. No application adapter or new dependency patch is needed for that field. Existing Google and xAI patches remain necessary, are version-bound to the upgraded packages, and retain their existing removal criteria.

## Selected versions

Registry publication times were read from the public npm metadata. The lockfile pins the exact versions and integrity hashes below. Private registry URLs introduced by the local install environment were removed from the lockfile before delivery.

| Package                     |     Old | Selected | Published UTC       |
| --------------------------- | ------: | -------: | ------------------- |
| `ai`                        | 6.0.168 |  6.0.288 | 2026-09-22 17:22:55 |
| `@ai-sdk/alibaba`           |  1.0.17 |   1.0.57 | 2026-09-22 03:13:41 |
| `@ai-sdk/amazon-bedrock`    | 4.0.112 |  4.0.180 | 2026-09-22 17:20:21 |
| `@ai-sdk/anthropic`         |  3.0.82 |  3.0.120 | 2026-09-22 17:21:53 |
| `@ai-sdk/azure`             |  3.0.49 |  3.0.123 | 2026-09-21 19:31:08 |
| `@ai-sdk/cerebras`          |  2.0.41 |   2.0.82 | 2026-09-21 19:31:11 |
| `@ai-sdk/cohere`            |  3.0.27 |   3.0.62 | 2026-09-21 19:30:52 |
| `@ai-sdk/deepinfra`         |  2.0.41 |   2.0.80 | 2026-09-21 19:34:07 |
| `@ai-sdk/gateway`           | 3.0.104 |  3.0.198 | 2026-09-22 17:20:53 |
| `@ai-sdk/google`            |  3.0.73 |  3.0.125 | 2026-09-21 19:31:19 |
| `@ai-sdk/google-vertex`     | 4.0.128 |  4.0.203 | 2026-09-22 17:19:40 |
| `@ai-sdk/groq`              |  3.0.31 |   3.0.67 | 2026-09-21 19:30:58 |
| `@ai-sdk/mistral`           |  3.0.27 |   3.0.65 | 2026-09-21 19:33:15 |
| `@ai-sdk/openai`            |  3.0.53 |  3.0.115 | 2026-09-21 19:34:19 |
| `@ai-sdk/openai-compatible` |  2.0.41 |   2.0.76 | 2026-09-21 19:31:25 |
| `@ai-sdk/perplexity`        |  3.0.26 |   3.0.61 | 2026-09-21 19:32:17 |
| `@ai-sdk/provider`          |   3.0.8 |   3.0.16 | 2026-09-09 18:14:17 |
| `@ai-sdk/provider-utils`    |  4.0.23 |   4.0.52 | 2026-09-21 19:31:46 |
| `@ai-sdk/togetherai`        |  2.0.41 |   2.0.82 | 2026-09-21 19:31:11 |
| `@ai-sdk/vercel`            |  2.0.39 |   2.0.78 | 2026-09-21 19:31:51 |
| `@ai-sdk/xai`               |  3.0.82 |  3.0.134 | 2026-09-21 19:31:54 |

## Consumer impact

- `packages/opencode` uses the AI SDK for provider construction, message transformation, streaming, tool calls, usage, errors, and cancellation. The same-major refresh type-checks without consumer API migration. Message transformation now omits absent `providerOptions` properties instead of serializing explicit `undefined` wire fields.
- `packages/core` and `packages/plugin` share the provider types. They are pinned to the same provider ABI to avoid duplicate or structurally incompatible model types.
- `packages/llm` is the Native/Core protocol implementation. It already normalizes OpenAI-compatible reasoning deltas and replays canonical reasoning as `reasoning_content`. A request-scoped `omitMaxTokens` option was added so reasoning distillation can intentionally remove inherited route/model output caps without losing other generation defaults.
- Google and xAI repository patches were rebased only by package version. Google still needs empty assistant-model entry filtering; xAI still needs the repository's wider PDF URL/base64/file-id mapping. Neither patch handles reasoning text.
- No proxy code or local model configuration was changed.

Relevant upstream references:

- [AI SDK OpenAI-compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers) documents native streaming, tools, usage, and reasoning-content support.
- [AI SDK OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai) distinguishes Chat Completions and Responses behavior, continuation IDs, and reasoning summaries.
- [AI SDK 7 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0) defines the deferred major-version migration.
- [DeepSeek Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion/) defines `reasoning_content` on assistant messages.

## Authorized endpoint observations

On 2026-09-26, bounded requests were sent to the configured `llms.ycgame.com/v1` endpoint using the locally supplied credential. Fixtures recorded only status codes, field names, event types, finish reasons, usage keys, and text lengths. Credentials, prompts beyond the fixed synthetic probe, and returned text were not written to the repository.

| Exact model ID        | Chat non-stream                                                    | Chat stream                                | Responses non-stream                                                                     | Responses stream                                                                  |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GLM-5.3-FLASH`       | 200; `content` + `reasoning_content`; finish `stop`; usage present | 200; both delta fields; no malformed event | 404; unavailable on this route                                                           | 404; unavailable on this route                                                    |
| `qwen3.8-flash`       | 200; `content` + `reasoning_content`; finish `stop`; usage present | 200; both delta fields; no malformed event | 200; output items `reasoning`, `message`; `output_text`; usage present                   | 200; `response.reasoning_text.*` and `response.output_text.*`; no malformed event |
| `deepseek-v4.1-flash` | 200; `content` + `reasoning_content`; finish `stop`; usage present | 200; both delta fields; no malformed event | 200; output items `reasoning`, `message`; `reasoning_text`, `output_text`; usage present | 200; `response.reasoning_text.*` and `response.output_text.*`; no malformed event |

These observations establish wire availability only. They do not establish distilled-history replacement, encrypted/signed item rewriting, server-managed continuation, or TUI reload. Those remain part of the reasoning-distillation acceptance run and must stay unverified for `GLM-5.3-FLASH` Responses while its route returns 404.

## Compatibility choices

| Gap                                    | Choice                                                  | Reason                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat `reasoning_content`               | Upstream support                                        | The upgraded OpenAI-compatible provider and the Native/Core OpenAI Chat protocol both parse it; adding a second adapter would risk duplication.              |
| Responses `reasoning_text`             | Capability-selected path in reasoning-distillation work | The field is protocol-specific and model/route availability differs. Selection must use an exact provider/protocol/model capability, not a family substring. |
| Inherited output caps for distillation | Application request flag                                | Removing `maxTokens` after defaults are merged is local, explicit, and testable; it avoids a provider patch and preserves other generation settings.         |
| Undefined provider options             | Application serialization fix                           | Omitting absent fields is provider-neutral and prevents unknown-field ambiguity without rewriting valid options.                                             |
| Google empty model entry               | Existing version-pinned patch                           | Still reproducible in 3.0.125; remove when upstream implements equivalent filtering and regression tests pass without it.                                    |
| xAI PDF mapping                        | Existing version-pinned patch                           | Upstream 3.0.134 supports URL input files but not the repository's complete URL/base64/file-id behavior; remove after upstream parity.                       |
| AI SDK 7                               | Deferred blocker                                        | Requires coordinated LanguageModelV4, runtime, ESM, callback, usage, gateway, custom provider, and test migration.                                           |

## Verification and rollback

Offline verification covers request-default precedence, provider-option serialization, Chat reasoning replay/deltas, tool calls, usage, malformed/truncated streams, and cancellation in the affected package suites. The reasoning-distillation delivery adds transport and full lineage/replay tests separately.

Rollback is one commit: restore the previous package pins and patch filenames, restore the previous lockfile resolutions, and remove `omitMaxTokens` plus its two call-site/serialization regressions. No data migration or proxy rollback is required.

This report is local evidence. Current PR-head CI and an installed DEV build remain required before #638 can be closed.
