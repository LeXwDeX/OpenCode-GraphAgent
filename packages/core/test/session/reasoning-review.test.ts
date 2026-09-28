import { expect, test } from "bun:test"
import { compactCandidateForReview } from "../../src/session/reasoning-distillation/review"
import type { Candidate, SourceSpan } from "../../src/session/reasoning-distillation/types"

const span = (messageID: string, partID: string, start: number, end: number): SourceSpan => ({
  messageID,
  partID,
  start,
  end,
  fingerprint: "f".repeat(64),
})

test("review aliases preserve every semantic range and candidate field across parts", () => {
  const ranges = Array.from({ length: 20 }, (_, index) =>
    span(index < 10 ? "m1" : "m2", "reasoning", index * 5, index * 5 + 5),
  )
  const partial = span("m2", "reasoning", 51, 53)
  const candidate: Candidate = {
    key: {
      sessionID: "secret-session",
      messageID: "m2",
      partIDs: ["reasoning"],
      sourceFingerprint: "private",
      capabilityFingerprint: "private",
      organizerFingerprint: "private",
      policyVersion: "v1",
    },
    fingerprint: "private",
    claims: [
      {
        id: "c1",
        kind: "decision",
        text: "保留约束",
        scope: "本会话",
        sources: [ranges[0], ranges[10], partial],
        evidence: [{ messageID: "m1", partID: "tool", kind: "tool-result", callID: "call-1" }],
        status: "verified",
      },
      {
        id: "c2",
        kind: "assumption",
        text: "暂未确认",
        scope: "环境A",
        sources: [ranges[1]],
        evidence: [],
        status: "assumed",
        supersedes: "c1",
      },
    ],
    preserved: [ranges[2], partial],
    coverage: ranges.map((source, index) =>
      index === 0
        ? { source, action: "keep" as const, claimID: "c1" }
        : index === 2
          ? { source, action: "preserve" as const }
          : index === 3
            ? { source, action: "merge" as const, witness: ranges[0] }
            : { source, action: "drop" as const, reason: "重复" },
    ),
  }
  const view = compactCandidateForReview(candidate)
  expect(compactCandidateForReview(candidate)).toEqual(view)
  const resolve = (alias: string) => {
    const [partIndex, start, end] = view.sourceSpans[Number(alias.slice(1))]
    const [messageID, partID] = view.sourceParts[partIndex]
    return { messageID, partID, start, end }
  }
  const location = ({ messageID, partID, start, end }: SourceSpan) => ({ messageID, partID, start, end })
  expect(view.claims.map((claim) => claim.sources.map(resolve))).toEqual(
    candidate.claims.map((claim) => claim.sources.map(location)),
  )
  expect(view.preserved.map(resolve)).toEqual(candidate.preserved.map(location))
  expect(
    view.coverage.map((entry) => ({
      source: resolve(entry.source),
      action: entry.action,
      ...("witness" in entry && entry.witness !== undefined ? { witness: resolve(entry.witness) } : {}),
      ...("claimID" in entry ? { claimID: entry.claimID } : {}),
      ...("reason" in entry ? { reason: entry.reason } : {}),
    })),
  ).toEqual(
    candidate.coverage.map((entry) => ({
      source: location(entry.source),
      action: entry.action,
      ...("witness" in entry ? { witness: location(entry.witness) } : {}),
      ...("claimID" in entry ? { claimID: entry.claimID } : {}),
      ...("reason" in entry ? { reason: entry.reason } : {}),
    })),
  )
  expect(view.claims.map(({ sources: _, ...rest }) => rest)).toEqual(
    candidate.claims.map(({ sources: _, ...rest }) => rest),
  )
  expect(view.sourceParts).toEqual([
    ["m1", "reasoning"],
    ["m2", "reasoning"],
  ])
  expect(JSON.stringify(view).length).toBeLessThan(JSON.stringify(candidate).length * 0.55)
  expect(JSON.stringify(view)).not.toContain("secret-session")
})
