import { ReasoningDistillationPolicy } from "./policy"
import type { Claim, CoverageEntry, DistillationSkipReason, SourceSpan } from "./types"

/**
 * Deterministic structural validation for claims, spans, and coverage (§5.4, §6.1). These are pure predicates over
 * host-supplied observations; they enforce the structural half of gates G1-G3 (identity, bounds, ordering, coverage
 * completeness, non-dangling supersedes). Semantic equivalence, meaning preservation, and support are judge work
 * (§5.4 validation method) and are intentionally not decided here.
 */

const CLAIM_KINDS = new Set<string>(["fact", "constraint", "decision", "rejection", "assumption", "state_delta"])
const CLAIM_STATUSES = new Set<string>(["verified", "unverified", "assumed"])
const EVIDENCE_KINDS = new Set<string>(["instruction", "source", "tool-input", "tool-result"])

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0

/** Stable identity for a span; used for ordering, overlap, and coverage matching. */
export const spanKey = (span: SourceSpan): string =>
  `${span.messageID}\u0000${span.partID}\u0000${span.start}\u0000${span.end}\u0000${span.fingerprint}`

const withinLimits = (count: number): boolean =>
  Number.isSafeInteger(count) && count >= 0 && count <= ReasoningDistillationPolicy.workLimits.maxContainerEntries

/**
 * Spans must be finite, individually well-formed (start >= 0, end > start, fingerprint present), ordered by
 * (messageID, partID, start), and non-overlapping within a part (§6.1: "source spans 有序且无越界").
 */
export const validateSourceSpans = (spans: readonly SourceSpan[]): DistillationSkipReason | undefined => {
  if (!Array.isArray(spans) || !withinLimits(spans.length)) return "work-limit"
  let previous: SourceSpan | undefined
  try {
    for (const span of spans) {
      if (!span || !nonEmpty(span.messageID) || !nonEmpty(span.partID) || !nonEmpty(span.fingerprint)) {
        return "invalid-reference"
      }
      if (
        !Number.isSafeInteger(span.start) ||
        !Number.isSafeInteger(span.end) ||
        span.start < 0 ||
        span.end <= span.start
      ) {
        return "invalid-reference"
      }
      if (previous) {
        const samePart = previous.messageID === span.messageID && previous.partID === span.partID
        const ordered =
          previous.messageID < span.messageID ||
          (previous.messageID === span.messageID && previous.partID < span.partID) ||
          (samePart && previous.start < span.start)
        if (!ordered) return "invalid-reference"
        // Overlap is only possible within the same part because spans are ordered across parts.
        if (samePart && span.start < previous.end) return "invalid-reference"
      }
      previous = span
    }
  } catch {
    return "invalid-reference"
  }
  return undefined
}

const validateEvidenceRefs = (claim: Claim): DistillationSkipReason | undefined => {
  if (!Array.isArray(claim.evidence) || !withinLimits(claim.evidence.length)) return "work-limit"
  for (const ref of claim.evidence) {
    if (!ref || !nonEmpty(ref.messageID) || !nonEmpty(ref.partID) || !EVIDENCE_KINDS.has(ref.kind)) {
      return "invalid-reference"
    }
    if (ref.callID !== undefined && !nonEmpty(ref.callID)) return "invalid-reference"
  }
  return undefined
}

/**
 * A single claim must carry a non-empty id, a known kind, non-empty text and scope (scope is mandatory per §5.3:
 * "unknown scope" must be preserved verbatim or skipped, never defaulted to global), at least one source span, and a
 * known status. Source spans inside a claim are validated for bounds but not re-checked for cross-claim ordering.
 */
export const validateClaim = (claim: Claim): DistillationSkipReason | undefined => {
  if (!claim) return "invalid-reference"
  if (!nonEmpty(claim.id) || !CLAIM_KINDS.has(claim.kind) || !nonEmpty(claim.text) || !nonEmpty(claim.scope)) {
    return "invalid-reference"
  }
  if (!CLAIM_STATUSES.has(claim.status)) return "invalid-reference"
  if (!Array.isArray(claim.sources) || claim.sources.length === 0 || !withinLimits(claim.sources.length)) {
    return "invalid-reference"
  }
  for (const span of claim.sources) {
    if (!span || !nonEmpty(span.messageID) || !nonEmpty(span.partID) || !nonEmpty(span.fingerprint)) {
      return "invalid-reference"
    }
    if (
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start
    ) {
      return "invalid-reference"
    }
  }
  if (claim.supersedes !== undefined && !nonEmpty(claim.supersedes)) return "invalid-reference"
  return validateEvidenceRefs(claim)
}

/**
 * The claim set must have unique ids, every claim structurally valid, and every `supersedes` edge resolve to a claim
 * that exists in the set (§5.3: supersedes must not dangle; the target keeps its identity, original text, and scope).
 * A claim may not supersede itself.
 */
export const validateClaimSet = (claims: readonly Claim[]): DistillationSkipReason | undefined => {
  if (!Array.isArray(claims) || !withinLimits(claims.length)) return "work-limit"
  const ids = new Set<string>()
  try {
    for (const claim of claims) {
      const reason = validateClaim(claim)
      if (reason) return reason
      if (ids.has(claim.id)) return "invalid-reference"
      ids.add(claim.id)
    }
    for (const claim of claims) {
      if (claim.supersedes === undefined) continue
      if (claim.supersedes === claim.id) return "invalid-reference"
      if (!ids.has(claim.supersedes)) return "invalid-reference"
    }
  } catch {
    return "invalid-reference"
  }
  return undefined
}

/**
 * Two claims are equivalent when kind, text, scope, and the source-span set all match. Equivalence drives merge/dedup
 * suggestions only; it never authorizes deletion (§5.4: the model's repeat/dead_end suggestions are advisory).
 */
export const claimEquivalence = (a: Claim, b: Claim): boolean => {
  if (a.kind !== b.kind || a.text !== b.text || a.scope !== b.scope) return false
  if (a.sources.length !== b.sources.length) return false
  const aKeys = a.sources.map(spanKey).sort()
  const bKeys = b.sources.map(spanKey).sort()
  return aKeys.every((key, index) => key === bKeys[index])
}

const coverageSourceKey = (entry: CoverageEntry): string => spanKey(entry.source)

/**
 * Every source span in R must be covered by exactly one coverage entry (keep/preserve/merge/drop); no span may
 * silently disappear (§5.4: "未覆盖片段不能静默消失", §6.1: "覆盖映射无漏项"). `keep` must resolve to a claim id,
 * `merge` must name a witness span, and `drop` must carry a non-empty reason. Coverage entries may not reference
 * spans outside R.
 */
export const validateCoverage = (
  coverage: readonly CoverageEntry[],
  spans: readonly SourceSpan[],
  claims: readonly Claim[],
): DistillationSkipReason | undefined => {
  if (!Array.isArray(coverage) || !withinLimits(coverage.length)) return "work-limit"
  const spanKeys = new Set<string>()
  for (const span of spans) spanKeys.add(spanKey(span))
  const claimIDs = new Set<string>()
  for (const claim of claims) claimIDs.add(claim.id)

  const covered = new Set<string>()
  try {
    for (const entry of coverage) {
      if (!entry || !entry.source) return "invalid-reference"
      const key = coverageSourceKey(entry)
      if (!spanKeys.has(key)) return "invalid-reference"
      if (covered.has(key)) return "retention-contract-violated"
      covered.add(key)
      switch (entry.action) {
        case "keep":
          if (!nonEmpty(entry.claimID) || !claimIDs.has(entry.claimID)) return "invalid-reference"
          break
        case "preserve":
          break
        case "merge":
          if (!entry.witness || !spanKeys.has(spanKey(entry.witness))) return "invalid-reference"
          break
        case "drop":
          if (!nonEmpty(entry.reason)) return "retention-contract-violated"
          break
        default:
          return "invalid-reference"
      }
    }
  } catch {
    return "invalid-reference"
  }

  for (const key of spanKeys) {
    if (!covered.has(key)) return "retention-contract-violated"
  }
  return undefined
}
