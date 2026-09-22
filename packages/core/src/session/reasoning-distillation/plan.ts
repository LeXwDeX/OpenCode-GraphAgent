import { Hash } from "../../util/hash"
import { spanKey, validateClaimSet, validateCoverage, validateSourceSpans } from "./claims"
import { ReasoningDistillationPolicy } from "./policy"
import type {
  AuditRecord,
  Claim,
  DistillationDependencies,
  DistillationKey,
  DistillationPlan,
  DistillationPlanInput,
  DistillationSkipReason,
  ModelProjection,
  SourceSpan,
  SupportResult,
  ValidationStamp,
  WireReasoningMapping,
} from "./types"

/**
 * Pure planning orchestrator (§5.2). Consumes host observations and explicit support verdicts; performs no I/O and
 * never disguises LLM extraction as deterministic parsing. The contract is a three-way result:
 * - applied:   replacements non-empty, extraCall "none",  skipReason undefined
 * - deferred:  replacements empty,     extraCall != "none", skipReason undefined (host makes the call, then re-plans)
 * - skipped:   replacements empty,     extraCall "none",  skipReason set (terminal; send the original)
 *
 * Execution-target audit (§5.5) and judge orchestration are wired in Phase 3; this layer keeps audit empty and routes
 * semantic verification through the support verdicts the host supplies.
 */

const emptyPlan = (skipReason: DistillationSkipReason, audit: readonly AuditRecord[] = []): DistillationPlan => ({
  replacements: [],
  audit,
  reusedCandidates: [],
  extraCall: "none",
  skipReason,
})

const deferredPlan = (extraCall: "propose" | "judge", audit: readonly AuditRecord[] = []): DistillationPlan => ({
  replacements: [],
  audit,
  reusedCandidates: [],
  extraCall,
  skipReason: undefined,
})

const allowedPurposes = new Set<string>(ReasoningDistillationPolicy.allowedPurposes)

/** Conservative character proxy; the real tokenizer is supplied by the runtime adapter in Phase 2. */
const defaultEstimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** Minimal renderer; the host original-text parser must be injected for preserved spans to render faithfully. */
const defaultRender = (
  claims: readonly Claim[],
  preserved: readonly SourceSpan[],
  resolveText: (span: SourceSpan) => string,
): string => {
  const claimLines = claims.map((claim) => `- ${claim.text}（范围：${claim.scope}）`)
  const preservedLines = preserved.map((span) => resolveText(span)).filter((text) => text.length > 0)
  return [...claimLines, ...preservedLines].join("\n")
}

const refKey = (messageID: string, partID: string): string => `${messageID}\u0000${partID}`

const capabilityOf = (mapping: WireReasoningMapping): string | undefined =>
  mapping.eligibility.allowed ? mapping.eligibility.capabilityFingerprint : undefined

const plan = (input: DistillationPlanInput, dependencies: DistillationDependencies): DistillationPlan => {
  // 1. Purpose gating (§5.1): auxiliary/unknown never sample, call, or apply cache.
  if (!allowedPurposes.has(input.purpose)) return emptyPlan("no-rewritable-slot")

  // 2. Trigger (§5.1): reuse the folding budget; only overBudget === true fires. Unknown budget never triggers.
  if (input.budget.overBudget !== true) return emptyPlan("below-target")

  // 3. Slot eligibility (§2/§5.1): need at least one authorized rewritable reasoning slot.
  const eligible = input.mappings.filter((mapping) => mapping.eligibility.allowed)
  if (eligible.length === 0) {
    const compatibilityBlocked = input.mappings.some(
      (mapping) => !mapping.eligibility.allowed && mapping.eligibility.protection === "P5",
    )
    return emptyPlan(compatibilityBlocked ? "compatibility-unproven" : "no-rewritable-slot")
  }

  // 4. Candidate availability (§5.2 step 3): no cached candidate requests one propose call, bounded by quota.
  const candidate = input.candidate
  if (!candidate) {
    if (input.quota.proposeUsed) return emptyPlan("call-budget-exhausted")
    return deferredPlan("propose")
  }

  // 5. Policy/version binding: a candidate stamped under a different policy is stale.
  if (candidate.key.policyVersion !== input.policyVersion) return emptyPlan("stale-validation")

  // 6. Structural validation: spans ordered/in-bounds, claim set well-formed, coverage complete.
  const spanReason = validateSourceSpans(input.evidence.spans)
  if (spanReason) return emptyPlan(spanReason)
  const claimReason = validateClaimSet(candidate.claims)
  if (claimReason) return emptyPlan(claimReason)
  const coverageReason = validateCoverage(candidate.coverage, input.evidence.spans, candidate.claims)
  if (coverageReason) return emptyPlan(coverageReason)

  // 7. G1 source-binding: every claim source span must locate within R; an unbound proposition is a new assertion.
  const rKeys = new Set<string>(input.evidence.spans.map(spanKey))
  for (const claim of candidate.claims) {
    for (const source of claim.sources) {
      if (!rKeys.has(spanKey(source))) return emptyPlan("new-assertion")
    }
  }

  // 8. G3 reference integrity: every evidence ref must resolve to a known span or call in this snapshot.
  const knownRefs = new Set<string>()
  for (const span of input.evidence.spans) knownRefs.add(refKey(span.messageID, span.partID))
  for (const call of input.evidence.calls) knownRefs.add(refKey(call.ref.messageID, call.ref.partID))
  for (const claim of candidate.claims) {
    for (const evidence of claim.evidence) {
      if (!knownRefs.has(refKey(evidence.messageID, evidence.partID))) return emptyPlan("evidence-unresolved")
    }
  }

  // 9. G4 support / semantic review: a verified claim needs targeted support. Missing or unknown support defers to a
  //    judge when quota remains; otherwise the original is sent and review is retried on the next legal trigger.
  const supportByClaim = new Map<string, SupportResult>(input.support.map((entry) => [entry.claimID, entry.result]))
  let needsJudge = false
  let anyJudged = false
  for (const claim of candidate.claims) {
    const support = supportByClaim.get(claim.id)
    if (!support || support.verdict === "unknown") {
      needsJudge = true
      break
    }
    if (support.verdict === "contradicted") return emptyPlan("evidence-unresolved")
    if (support.method === "judged") anyJudged = true
  }
  if (needsJudge) {
    if (input.quota.judgeUsed) return emptyPlan("semantic-review-required")
    return deferredPlan("judge")
  }
  if (anyJudged && input.judgeFingerprint === undefined) return emptyPlan("stale-validation")

  // 10. Render the projection from validated claims and preserved spans only (§5.5.3 isolation).
  const resolveText = dependencies.resolveText ?? (() => "")
  const render = dependencies.render ?? defaultRender
  const estimateTokens = dependencies.estimateTokens ?? defaultEstimateTokens
  const fingerprint = dependencies.fingerprint ?? Hash.sha256
  const text = render(candidate.claims, candidate.preserved, resolveText)

  // 11. Savings gate (§5.8): a non-positive estimate skips the projection.
  if (input.originalTokens === undefined || !Number.isSafeInteger(input.originalTokens))
    return emptyPlan("unknown-content")
  const estimatedSavings = input.originalTokens - estimateTokens(text)
  if (estimatedSavings < ReasoningDistillationPolicy.tokens.minimumNetSavingsTokens) {
    return emptyPlan("insufficient-net-savings")
  }

  // 12. Assemble one replacement per eligible slot, each carrying its own capability-bound validation stamp.
  const projection: ModelProjection = { claims: candidate.claims, preserved: candidate.preserved, text }
  const reusedCandidates: DistillationKey[] = [candidate.key]
  const replacements = eligible.flatMap((mapping) => {
    const capabilityFingerprint = capabilityOf(mapping)
    if (capabilityFingerprint === undefined) return []
    const validation: ValidationStamp = {
      candidateFingerprint: fingerprint(candidate.fingerprint),
      evidenceFingerprint: input.evidence.inventoryFingerprint,
      capabilityFingerprint,
      validatorVersion: ReasoningDistillationPolicy.validatorVersion,
      method: anyJudged ? "judged" : "deterministic",
      ...(anyJudged ? { judgeFingerprint: input.judgeFingerprint! } : {}),
    }
    return [{ mapping, projection, validation, estimatedSavings }]
  })
  if (replacements.length === 0) return emptyPlan("mapping-mismatch")

  return { replacements, audit: [], reusedCandidates, extraCall: "none", skipReason: undefined }
}

export const planReasoningDistillation = (
  input: DistillationPlanInput,
  dependencies: DistillationDependencies = {},
): DistillationPlan => {
  try {
    return plan(input, dependencies)
  } catch {
    return emptyPlan("projection-failed")
  }
}
