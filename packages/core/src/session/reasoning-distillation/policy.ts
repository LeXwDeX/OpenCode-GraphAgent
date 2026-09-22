import type { DistillationPurpose, ModelTier } from "./types"

/**
 * Reasoning-distillation policy constants (§5.6, §5.8). Pure data; the host supplies live model availability and
 * budget observations. Values are conservative defaults pending the §6.2 baseline; compression rate never offsets
 * a safety, false-positive, or cost failure.
 */
export const ReasoningDistillationPolicy = {
  version: "reasoning-distillation-v1",
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
    /** Paid-candidate admission window: amortized over at most this many subsequent real sends (§5.8). */
    amortizationWindow: 8,
  },
  tokens: {
    /** Auxiliary input/output caps, further bounded by the selected model's smaller limit (§5.8). */
    maxInputTokens: 32_768,
    maxOutputTokens: 4_096,
    /** A non-positive estimated saving skips the call/projection (§5.8). */
    minimumNetSavingsTokens: 1,
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
