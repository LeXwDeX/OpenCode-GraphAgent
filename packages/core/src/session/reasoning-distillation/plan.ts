import { Hash } from "../../util/hash"
import { assembleAudit, gateViolationToFinding, resolveExecutionMatch, resolveExecutionVerdict } from "./audit"
import { evaluateGates } from "./gates"
import { ReasoningDistillationPolicy } from "./policy"
import type {
  AuditFinding,
  AuditRecord,
  Claim,
  DistillationDependencies,
  DistillationKey,
  DistillationPlan,
  DistillationPlanInput,
  DistillationSkipReason,
  ModelProjection,
  SourceSpan,
  ValidationStamp,
  WireReasoningMapping,
} from "./types"

/**
 * Pure planning orchestrator (§5.2). Consumes host observations, support verdicts, and optional execution targets;
 * performs no I/O and never disguises LLM extraction as deterministic parsing. The result is three-way:
 * - applied:   replacements non-empty, extraCall "none",   skipReason undefined
 * - deferred:  replacements empty,     extraCall != "none", skipReason undefined (host makes the call, then re-plans)
 * - skipped:   replacements empty,     extraCall "none",   skipReason set (terminal; send the original)
 *
 * Gate evaluation (§5.4) and the conservation audit (§5.5) run on every present candidate, and the audit is recorded
 * even when the candidate is rejected, so a fidelity failure never swallows fabricated/concealed/evidence_swap or
 * source-agent execution findings. Judge/propose model orchestration is the host's job (Phase 3b/2 runtime).
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

const capabilityOf = (mapping: WireReasoningMapping): string | undefined =>
  mapping.eligibility.allowed ? mapping.eligibility.capabilityFingerprint : undefined

/** Resolve and verdict each host-supplied execution target (§5.5); findings attribute to the source agent. */
const auditExecutionTargets = (input: DistillationPlanInput): AuditFinding[] => {
  const targets = input.targets ?? []
  if (targets.length === 0) return []
  const contextByTarget = new Map((input.executionContext ?? []).map((entry) => [entry.targetID, entry]))
  const findings: AuditFinding[] = []
  for (const target of targets) {
    const match = resolveExecutionMatch(target, input.evidence)
    const context = contextByTarget.get(target.id)
    const finding = resolveExecutionVerdict({
      target,
      match,
      sourceStatesFailure: context?.sourceStatesFailure ?? false,
      support: context?.support ?? { verdict: "unknown", reasonCode: "no-verdict-context" },
    })
    if (finding) findings.push(finding)
  }
  return findings
}

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

  // 6. Gates G1-G4 (§5.4) + conservation audit (§5.5). Diagnostics are assembled before any rejection so a fidelity
  //    failure never hides fabricated/concealed/evidence_swap or source-agent execution findings (§5.2 step 4).
  const gates = evaluateGates(candidate, input.evidence, input.support)
  const distillerFindings = gates.violations.map(gateViolationToFinding)
  const executionFindings = auditExecutionTargets(input)
  const audit = assembleAudit(executionFindings, distillerFindings)

  // 7. Terminal structural failure -> reject the candidate but keep the diagnostics.
  if (gates.skipReason) return emptyPlan(gates.skipReason, audit)

  // 8. Semantic review still required -> defer to one judge call when quota remains; otherwise send the original and
  //    retry on the next legal trigger (§5.2 step 5).
  if (gates.needsSemanticReview) {
    if (input.quota.judgeUsed) return emptyPlan("semantic-review-required", audit)
    return deferredPlan("judge", audit)
  }
  if (gates.anyJudged && input.judgeFingerprint === undefined) return emptyPlan("stale-validation", audit)

  // 9. Render the projection from validated claims and preserved spans only (§5.5.3 isolation).
  const resolveText = dependencies.resolveText ?? (() => "")
  const render = dependencies.render ?? defaultRender
  const estimateTokens = dependencies.estimateTokens ?? defaultEstimateTokens
  const fingerprint = dependencies.fingerprint ?? Hash.sha256
  const text = render(candidate.claims, candidate.preserved, resolveText)

  // 10. Savings gate (§5.8): a non-positive estimate skips the projection.
  if (input.originalTokens === undefined || !Number.isSafeInteger(input.originalTokens)) {
    return emptyPlan("unknown-content", audit)
  }
  const estimatedSavings = input.originalTokens - estimateTokens(text)
  if (estimatedSavings < ReasoningDistillationPolicy.tokens.minimumNetSavingsTokens) {
    return emptyPlan("insufficient-net-savings", audit)
  }

  // 11. Assemble one replacement per eligible slot, each carrying its own capability-bound validation stamp.
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
      method: gates.anyJudged ? "judged" : "deterministic",
      ...(gates.anyJudged ? { judgeFingerprint: input.judgeFingerprint! } : {}),
    }
    return [{ mapping, projection, validation, estimatedSavings }]
  })
  if (replacements.length === 0) return emptyPlan("mapping-mismatch", audit)

  return { replacements, audit, reusedCandidates, extraCall: "none", skipReason: undefined }
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
