# Reasoning Distillation — Real-Model Evidence (2026-09-27)

Issue: #643. Scope: real-model verification of the reasoning-distillation auxiliary
chain (propose stage end-to-end; fail-closed paths; metering). Complements the
mock-based acceptance in #643 and the 20-session holdout (separate document).

## Environment

- Integration worktree `feat/dev-runtime-reliability` at `4cd43d690c` + this fix
  (`58e8a024a6`), run from source with Bun 1.3.14.
- Provider: a local OpenAI-compatible relay fronting three upstream reasoning
  models: `qwen-max` (main model), `glm` (auxiliary organizer / small tier),
  `deepseek` (observation only). The relay speaks SSE `reasoning_content`
  deltas for interleaved reasoning, which is the surface #643 distills.
- Isolated runtime: dedicated `OPENCODE_CONFIG`, `XDG_DATA_HOME`, cache/state
  dirs; all traffic captured through a raw-wire recording proxy (request/response
  bodies persisted locally; the proxy is a throwaway harness, not committed).
- Authorized compatibility tuple (from #643 D2) written into the isolated
  config: runtime `opencode-ai-sdk`, protocol `openai-compatible`,
  providerModelVariant `local-proxy-compatible/qwen-max/default`,
  endpointIdentity `69115c1ad0bf33e3ca8fc797d75e84a64ad3d14cfe91616ba547914d09a89544`,
  adapterVersion `opencode-reasoning-distillation-ai-sdk-v1`,
  optionsFingerprint `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`.
- Model limit overrides in the isolated config: qwen-max context 50000 /
  output 8000 (organizer floor = policy maxInputTokens + maxOutputTokens must
  fit the main context; 50000 ≥ 32768 + 24576).

## Verification matrix (Acceptance #643 deltas)

The acceptance text names `qwen3.8-flash`; that model is not available on the
authorized relay. Substitute organizer models actually exercised: `glm`
(primary organizer) and `qwen-max` (agent-tier fallback observation). This
substitution is noted here as the only deviation from the acceptance text.

| Acceptance item | Result |
| --- | --- |
| Wire: interleaved `reasoning_content` present | PASS — SSE deltas captured on the raw wire for all three models |
| Persisted: reasoning parts stored | PASS — `reasoning` parts in the local SQLite store (message parts table) |
| Replay: outbound history carries reasoning | PASS — follow-up requests include non-empty `reasoning_content` on historical assistant messages |
| Compatibility gate: no tuple → no aux | PASS — removing the compatibility record yields `attempted=none` with a tuple skip reason; no auxiliary request on the wire |
| Budget gate: estimated ≤ soft target → no aux | PASS — `skip_reason=below-target` at 17.5K–22K estimated tokens against a 29400-token soft target; aux fires at 33K |
| Organizer resolution | PASS — small tier (`glm`) selected; insufficient-context and duplicate fingerprints fall through tiers (unit-covered; floor observed live) |
| Aux call issued + metered | PASS — after the fixes below: `aux_actual_tokens` 2243/1879/2768/4918 across runs, `aux_unknown_usage_calls=0`, `paid_admission_paused=false` |
| Fail-closed on unknown usage | PASS — while responses were unusable, every attempt recorded `aux_unknown_usage_calls=1` and `paid_admission_paused=true`; subsequent sends in the same process refused with `call-budget-exhausted` |
| Fail-closed on timeout | PASS — aux attempts cut at exactly the configured timeout (180007 ms / 300017 ms observed) settled as unknown usage and paused admission |
| Judge → applied (real session) | PENDING — propose→judge→apply sequencing is covered by in-process E2E tests; live-session observation is deferred to the 20-session holdout |

## Findings — five real-only failure modes, all fixed in `58e8a024a6`

1. **Aux timeout too small for slow relays.** The hardcoded 30s timeout cut
   organizer calls on relays with multi-minute queueing (observed 180s/300s
   timeouts). Fix: `OPENCODE_REASONING_DISTILLATION_AUX_TIMEOUT_MS`
   (default unchanged).
2. **Output cap smaller than reasoning.** With the relay's default thinking
   mode, the organizer spent the entire `maxOutputTokens` on
   `reasoning_content` before any answer (4096 → empty content; 16384 →
   truncated JSON; reasoning volume grew with the cap). Fix: policy cap
   24576 plus pinning `reasoning_effort: low` on auxiliary calls, which
   collapsed reasoning to ~100 chars and cut latency to 9–20s.
3. **Prompts did not expose resolvable span identities.** Slots were rendered
   as `[slot 0]` while the span resolver requires the real
   `(messageID, partID)`; models invented ids and every source was rejected.
   Fix: prompts now render the real ids and require verbatim use.
4. **Shape ambiguities.** Models omitted empty arrays (`evidence` missing →
   candidate rejected), invented evidence kinds (`"tool"` outside the enum),
   and occasionally wrapped JSON in markdown fences. Fixes: prompts list the
   evidence kind enum, require the four array fields to always be present,
   define `merge.witness` as a span object; `strictJSON` strips fences.
5. **Silent unknown-usage.** Missing provider usage settled as unknown with no
   diagnostic. Fix: privacy-safe warning when `totalUsage.totalTokens` is not
   a number (text length + presence only; no content).

Relay-side limitation (documented, no code change): the upstream gateway
aborts long non-stream completions (~4.5–5 min). With `reasoning_effort: low`
auxiliary calls finish in 9–20s, well inside every bound.

## Latency / cost observations (auxiliary propose, glm, effort=low)

- Latency: 9.5s / 14.2s / 17.1s / 17.5s / 18.4s across successful runs.
- Aux usage: 1879–4918 total tokens per propose on a ~1500-char reasoning slot.
- Session reserve accounting matched `promptTokens + 24576` and stayed far
  below the 262144 per-session reservation ceiling.

## Artifacts

- Raw wire captures: local `/tmp/ga-wire/qmax-chain/` (ephemeral harness
  output; request/response bodies only, no credentials — the proxy strips
  nothing but the Authorization header is never written to captures).
- Log lines: `reasoning_distillation.*` fields in the isolated runtime log,
  including `aux_reserved_tokens`, `aux_actual_tokens`,
  `aux_unknown_usage_calls`, `aux_latency_ms`, `paid_admission_paused`.
- Offline replay: captured auxiliary outputs were re-parsed with the exact
  `parseCandidate` + span-resolver code paths to attribute each rejection to
  its schema rule; the five findings above are derived from that replay.

## Privacy

No API keys, base URLs, prompts, reasoning content, or user data are embedded
in this document. Span/claim samples are described structurally, not quoted.
