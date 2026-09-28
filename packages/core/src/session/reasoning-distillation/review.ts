import type { Candidate, SourceSpan } from "./types"

/** A source alias refers to one exact UTF-16 range in sourceSpans; its part is in sourceParts. */
export const compactCandidateForReview = (candidate: Candidate) => {
  const sourceParts: [string, string][] = []
  const sourceSpans: [number, number, number][] = []
  const parts = new Map<string, number>()
  const spans = new Map<string, string>()
  const alias = (span: SourceSpan): string => {
    const partKey = JSON.stringify([span.messageID, span.partID])
    let part = parts.get(partKey)
    if (part === undefined) {
      part = sourceParts.length
      parts.set(partKey, part)
      sourceParts.push([span.messageID, span.partID])
    }
    const spanKey = JSON.stringify([part, span.start, span.end])
    let result = spans.get(spanKey)
    if (result === undefined) {
      result = `S${sourceSpans.length}`
      spans.set(spanKey, result)
      sourceSpans.push([part, span.start, span.end])
    }
    return result
  }
  const claims = candidate.claims.map((claim) => ({
    id: claim.id,
    kind: claim.kind,
    text: claim.text,
    scope: claim.scope,
    sources: claim.sources.map(alias),
    evidence: claim.evidence,
    status: claim.status,
    ...(claim.supersedes === undefined ? {} : { supersedes: claim.supersedes }),
  }))
  const preserved = candidate.preserved.map(alias)
  const coverage = candidate.coverage.map((entry) => {
    const source = alias(entry.source)
    switch (entry.action) {
      case "keep":
        return { source, action: entry.action, claimID: entry.claimID }
      case "preserve":
        return { source, action: entry.action }
      case "merge":
        return { source, action: entry.action, witness: alias(entry.witness) }
      case "drop":
        return { source, action: entry.action, reason: entry.reason }
      default:
        throw new Error("Unknown reasoning coverage action")
    }
  })
  return { sourceParts, sourceSpans, claims, preserved, coverage }
}
