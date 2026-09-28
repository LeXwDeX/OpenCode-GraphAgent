import { spanBelongsToSource, validateClaimSet, validateCoverage, validateSourceSpans } from "./claims"
import type {
  AuditConfidence,
  AuditViolationKind,
  Candidate,
  ClaimSupport,
  DistillationSkipReason,
  EvidenceRef,
  ReasoningEvidence,
  SupportResult,
  SourceSpan,
} from "./types"

/**
 * Deterministic gate evaluation (§5.4). Pure: consumes the candidate, the host evidence snapshot, and the support
 * verdicts the host already produced; returns (a) audit violations attributable to the distiller, (b) whether an
 * independent judge is still required, and (c) the first terminal structural failure that blocks any projection.
 *
 * Only transformations with an actual deterministic rule are approved here (exact-range representation preservation,
 * resolved structured-state predicates, supplied deterministic support). General semantic rewriting, noise deletion,
 * and support/contradiction beyond those rules set needsSemanticReview for the judge (§5.4); the proposer's own
 * self-assessment never substitutes for it.
 */

export type GateID = "G1" | "G2" | "G3" | "G4"

export type GateViolation = Readonly<{
  gate: GateID
  kind: AuditViolationKind
  claimID?: string
  evidence: readonly EvidenceRef[]
  confidence: AuditConfidence
  reasonCode: string
}>

export type GateEvaluation = Readonly<{
  violations: readonly GateViolation[]
  needsSemanticReview: boolean
  /** True when at least one claim carries a judge-produced support verdict (the validation stamp must be "judged"). */
  anyJudged: boolean
  /** First terminal structural failure that blocks projection; undefined when only semantic review is pending. */
  skipReason: DistillationSkipReason | undefined
}>

const SEP = "\u0000"
const partKey = (messageID: string, partID: string): string => `${messageID}${SEP}${partID}`

const noViolations = (skipReason: DistillationSkipReason | undefined, needsSemanticReview = false): GateEvaluation => ({
  violations: [],
  needsSemanticReview,
  anyJudged: false,
  skipReason,
})

/**
 * Evaluate G1-G4 deterministically. Structural malformation (bad spans/claims/coverage shape) yields a skipReason
 * without a distiller finding because it is invalid input, not a proven semantic violation.
 */
export const evaluateGates = (
  candidate: Candidate,
  evidence: ReasoningEvidence,
  support: readonly ClaimSupport[],
  options: { resolveText?: (span: SourceSpan) => string; retentionSupport?: SupportResult } = {},
): GateEvaluation => {
  // Structural pre-checks: malformed input is rejected, not attributed as fraud.
  const spanReason = validateSourceSpans(evidence.spans)
  if (spanReason) return noViolations(spanReason)
  const claimReason = validateClaimSet(candidate.claims)
  if (claimReason) return noViolations(claimReason)
  const coverageReason = validateCoverage(
    candidate.coverage,
    evidence.spans,
    candidate.claims,
    candidate.preserved,
    options.resolveText,
  )
  // A coverage shape error (unknown claim/witness, outside-R reference) is invalid input; an uncovered span is G2.
  if (coverageReason && coverageReason !== "retention-contract-violated") return noViolations(coverageReason)

  const violations: GateViolation[] = []

  const references: readonly EvidenceRef[] =
    evidence.references ??
    evidence.spans.map((span) => ({
      messageID: span.messageID,
      partID: span.partID,
      kind: "source" as const,
    }))
  const partPosition = new Map<string, number>()
  references.forEach((ref, index) => {
    const key = partKey(ref.messageID, ref.partID)
    if (!partPosition.has(key)) partPosition.set(key, index)
  })

  // G1 (no new proposition): every claim source span must locate within R.
  let g1Failed = false
  for (const claim of candidate.claims) {
    for (const source of claim.sources) {
      if (!spanBelongsToSource(source, evidence.spans, options.resolveText)) {
        g1Failed = true
        violations.push({
          gate: "G1",
          kind: "fabricated",
          claimID: claim.id,
          evidence: [{ messageID: source.messageID, partID: source.partID, kind: "source" }],
          confidence: "deterministic",
          reasonCode: "g1-unbound-source",
        })
      }
    }
  }

  // G2 (information preservation): every R span must be covered by the candidate's coverage map.
  let g2Failed = false
  for (const span of evidence.spans) {
    if (coverageReason === "retention-contract-violated") {
      g2Failed = true
      violations.push({
        gate: "G2",
        kind: "concealed",
        evidence: [{ messageID: span.messageID, partID: span.partID, kind: "source" }],
        confidence: "deterministic",
        reasonCode: "g2-uncovered-span",
      })
    }
  }

  // G3 (reference integrity): evidence must resolve in this snapshot and must not postdate the claim assertion.
  let g3Failed = false
  for (const claim of candidate.claims) {
    const sourcePositions = claim.sources
      .map((source) => partPosition.get(partKey(source.messageID, source.partID)))
      .filter((position): position is number => position !== undefined)
    const assertionPosition = sourcePositions.length > 0 ? Math.max(...sourcePositions) : undefined
    for (const ref of claim.evidence) {
      const key = partKey(ref.messageID, ref.partID)
      const bound = references.some(
        (item) =>
          item.messageID === ref.messageID &&
          item.partID === ref.partID &&
          item.kind === ref.kind &&
          item.callID === ref.callID,
      )
      const toolRef = ref.kind === "tool-input" || ref.kind === "tool-result"
      const callBound =
        !toolRef ||
        evidence.calls.some(
          (call) =>
            call.ref.messageID === ref.messageID &&
            call.ref.partID === ref.partID &&
            call.ref.callID === ref.callID &&
            (ref.kind !== "tool-result" || call.result === "complete"),
        )
      if (!bound || !callBound || assertionPosition === undefined) {
        g3Failed = true
        violations.push({
          gate: "G3",
          kind: "evidence_swap",
          claimID: claim.id,
          evidence: [ref],
          confidence: "deterministic",
          reasonCode: "g3-unresolved-evidence",
        })
        continue
      }
      // Temporal compatibility: citing a strictly later part to prove an earlier assertion is a mismatch (§5.4).
      const evidencePosition = partPosition.get(key)
      if (assertionPosition !== undefined && evidencePosition !== undefined && evidencePosition > assertionPosition) {
        g3Failed = true
        violations.push({
          gate: "G3",
          kind: "evidence_swap",
          claimID: claim.id,
          evidence: [ref],
          confidence: "deterministic",
          reasonCode: "g3-future-evidence",
        })
      }
    }
  }

  // G4 (proposition support): a verified claim needs targeted support; contradiction is a violation, absence defers.
  const supportByClaim = new Map<string, SupportResult>(support.map((entry) => [entry.claimID, entry.result]))
  const semanticChange =
    candidate.claims.length > 0 ||
    candidate.coverage.some((entry) => entry.action === "drop" || entry.action === "merge")
  const retention = options.retentionSupport
  // Empty output erases the entire source slot. Require an independent judge even if a caller supplies a
  // deterministic whole-source verdict; structural coverage alone cannot certify that everything was noise.
  const emptyOutput = candidate.claims.length === 0 && candidate.preserved.length === 0
  let needsSemanticReview =
    semanticChange && (!retention || retention.verdict === "unknown" || (emptyOutput && retention.method !== "judged"))
  let anyJudged = semanticChange && retention?.verdict === "supported" && retention.method === "judged"
  if (semanticChange && retention?.verdict === "contradicted") {
    g2Failed = true
    violations.push({
      gate: "G2",
      kind: "concealed",
      evidence: [],
      confidence: retention.method,
      reasonCode: "g2-retention-contradicted",
    })
  }
  let g4Failed = false
  for (const claim of candidate.claims) {
    const verdict = supportByClaim.get(claim.id)
    if (!verdict || verdict.verdict === "unknown") {
      needsSemanticReview = true
      continue
    }
    if (verdict.verdict === "contradicted") {
      g4Failed = true
      violations.push({
        gate: "G4",
        kind: "evidence_swap",
        claimID: claim.id,
        evidence: claim.evidence,
        confidence: verdict.method,
        reasonCode: "g4-contradicted",
      })
    } else if (verdict.method === "judged") {
      anyJudged = true
    }
  }

  // The first terminal structural failure wins; semantic review alone is not terminal (the judge may still approve).
  const skipReason: DistillationSkipReason | undefined = g1Failed
    ? "new-assertion"
    : g2Failed
      ? "retention-contract-violated"
      : g3Failed || g4Failed
        ? "evidence-unresolved"
        : undefined

  return { violations, needsSemanticReview, anyJudged, skipReason }
}

/** Parse only the independent judge's whole-source retention verdict. */
export const parseRetention = (raw: unknown): SupportResult | undefined => {
  if (typeof raw !== "object" || raw === null || !("retention" in raw)) return undefined
  const value = raw.retention
  if (typeof value !== "object" || value === null || !("verdict" in value)) return undefined
  if (value.verdict === "supported" || value.verdict === "contradicted")
    return { verdict: value.verdict, method: "judged" }
  if (value.verdict === "unknown" && "reasonCode" in value && typeof value.reasonCode === "string")
    return { verdict: "unknown", reasonCode: value.reasonCode }
  return undefined
}
