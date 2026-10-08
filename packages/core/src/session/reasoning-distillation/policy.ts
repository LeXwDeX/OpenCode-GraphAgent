import type { DistillationPurpose, ModelTier } from "./types"

/**
 * Reasoning-distillation policy constants (§5.6, §5.8). Pure data; the host supplies live model availability and
 * budget observations. Values are conservative defaults pending the §6.2 baseline; compression rate never offsets
 * a safety, false-positive, or cost failure.
 */
export const ReasoningDistillationPolicy = {
  version: "reasoning-distillation-v2-denoise",
  validatorVersion: "gates-v1",
  /** Propose/judge resolution order (§5.6): small model, then the current agent model, then the session primary. */
  modelTierOrder: ["small", "agent", "primary"] as readonly ModelTier[],
  /** Purposes allowed to distill (§5.1). auxiliary/unknown never sample, call, or apply cache. */
  allowedPurposes: ["conversation", "compaction"] as readonly DistillationPurpose[],
  calls: {
    /** Per source identity: propose at most once, judge at most once, total at most two, across trigger cycles. */
    maxProposePerIdentity: 1,
    maxJudgePerIdentity: 1,
    maxCallsPerIdentity: 2,
    /** Hard project-runtime ceiling per session; failures and cancellations count. */
    maxCallsPerSession: 32,
    /** Consecutive auxiliary failures without a response before a session stops calling until restart. */
    maxConsecutiveFailures: 3,
    /** Paid-candidate admission window: amortized over at most this many subsequent real sends (§5.8). */
    amortizationWindow: 8,
  },
  tokens: {
    /** Auxiliary input/output caps, further bounded by the selected model's smaller limit (§5.8).
     * maxOutputTokens must leave room for interleaved reasoning: reasoning models on
     * openai-compatible relays spend the cap on reasoning_content before emitting the
     * answer, so a small cap yields empty answers (observed on real qwen/deepseek/glm
     * relays, 2026-09-27). */
    maxInputTokens: 32_768,
    maxOutputTokens: 24_576,
    /** Hard admission-reservation ceiling per session. State is held per
     * sessionID inside one distillation-runner instance, so exhausting the
     * ceiling in one session never blocks another session sharing the same
     * runner. Budget and pause state are process-local: a restart starts a
     * fresh budget and clears the pause flag (deliberate; durable metering
     * would need a schema/migration the v1 scope does not carry). */
    maxReservedTokensPerSession: 262_144,
    /** A replacement must be at least this many estimated tokens smaller than its source (§5.8). */
    minimumNetSavingsTokens: 1,
    /** Reasoning below this estimated size is left as is: the organizer prompt alone costs more. */
    minimumInputTokens: 32,
  },
  cache: {
    /** Initial entry cap; total derived-body cap; whichever hits first evicts by insertion order (§5.8). */
    maxEntries: 4_096,
    maxDerivedBodyBytes: 16 * 1_024 * 1_024,
  },
  workLimits: {
    maxInputBytes: 8 * 1_024 * 1_024,
    maxOutputCharacters: 64 * 1_024 * 1_024,
    maxNodes: 131_072,
    maxContainerEntries: 131_072,
    maxDepth: 64,
  },
} as const
