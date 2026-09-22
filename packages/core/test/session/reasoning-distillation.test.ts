import { describe, expect, test } from "bun:test"
import type { ContextFoldingBudget } from "../../src/session/context-folding"
import {
  claimEquivalence,
  planReasoningDistillation,
  resolveExecutionMatch,
  resolveExecutionVerdict,
  spanKey,
  validateClaim,
  validateClaimSet,
  validateCoverage,
  validateSourceSpans,
  type CallObservation,
  type Candidate,
  type Claim,
  type ClaimSupport,
  type CoverageEntry,
  type DistillationPlanInput,
  type ExecutionTarget,
  type ReasoningEvidence,
  type SourceSpan,
  type SupportMethod,
  type WireReasoningMapping,
} from "../../src/session/reasoning-distillation"

const POLICY_VERSION = "reasoning-distillation-v1"

const span = (messageID: string, partID: string, start: number, end: number, fingerprint?: string): SourceSpan => ({
  messageID,
  partID,
  start,
  end,
  fingerprint: fingerprint ?? `${messageID}:${partID}:${start}`,
})

const claim = (id: string, overrides: Partial<Claim> = {}): Claim => ({
  id,
  kind: "decision",
  text: "采用方案 A",
  scope: "本次会话",
  sources: [span("m1", "p1", 0, 10)],
  evidence: [{ messageID: "m1", partID: "p1", kind: "source" }],
  status: "verified",
  ...overrides,
})

const budget = (overBudget: boolean | undefined): ContextFoldingBudget => ({
  usableInputTokens: 1000,
  targetTokens: 700,
  estimatedInputTokens: 900,
  overBudget,
  inputBytes: 4000,
  skipReason: undefined,
})

const eligibleMapping = (capabilityFingerprint = "cap1"): WireReasoningMapping => ({
  refs: [{ messageID: "m1", partID: "p1" }],
  shape: "interleaved-field",
  eligibility: { allowed: true, capabilityFingerprint },
  bodyPath: ["messages", 0, "content"],
  sourceFingerprint: "sf1",
})

const protectedMapping = (protection: "P1" | "P2" | "P3" | "P4" | "P5"): WireReasoningMapping => ({
  refs: [{ messageID: "m1", partID: "p1" }],
  shape: "interleaved-field",
  eligibility: { allowed: false, protection },
  bodyPath: ["messages", 0, "content"],
  sourceFingerprint: "sf1",
})

const call = (
  callID: string,
  toolName: string,
  status: CallObservation["status"],
  result: CallObservation["result"] = "complete",
): CallObservation => ({
  ref: { messageID: "m1", partID: `part-${callID}`, callID, kind: "tool-result" },
  toolName,
  status,
  result,
  provenance: "corroborated",
})

const evidence = (
  spans: readonly SourceSpan[],
  calls: readonly CallObservation[] = [],
  inventoryComplete = true,
): ReasoningEvidence => ({
  spans,
  calls,
  inventoryComplete,
  inventoryFingerprint: "inv1",
})

const candidate = (
  claims: readonly Claim[],
  coverage: readonly CoverageEntry[],
  overrides: Partial<Candidate> = {},
): Candidate => ({
  key: {
    sessionID: "s1",
    messageID: "m1",
    partIDs: ["p1"],
    sourceFingerprint: "sf1",
    capabilityFingerprint: "cap1",
    organizerFingerprint: "org1",
    policyVersion: POLICY_VERSION,
  },
  fingerprint: "cand1",
  claims,
  preserved: [],
  coverage,
  ...overrides,
})

const planInput = (overrides: Partial<DistillationPlanInput> = {}): DistillationPlanInput => ({
  purpose: "conversation",
  budget: budget(true),
  candidate: undefined,
  evidence: evidence([]),
  mappings: [eligibleMapping()],
  quota: { proposeUsed: false, judgeUsed: false },
  originalTokens: 1000,
  support: [],
  policyVersion: POLICY_VERSION,
  ...overrides,
})

const target = (overrides: Partial<ExecutionTarget> = {}): ExecutionTarget => ({
  id: "t1",
  claimID: "c1",
  modality: "reported",
  requiredBy: [{ messageID: "m1", partID: "p1" }],
  toolName: "bash",
  selector: { kind: "at-least-one" },
  expectation: "succeeded",
  scope: { messageIDs: ["m1"], stepIDs: [], settled: true },
  ...overrides,
})

const supported = (method: SupportMethod = "deterministic"): ClaimSupport["result"] => ({
  verdict: "supported",
  method,
})

describe("validateSourceSpans", () => {
  test("accepts ordered, non-overlapping, in-bounds spans", () => {
    expect(validateSourceSpans([span("m1", "p1", 0, 10), span("m1", "p1", 10, 20)])).toBeUndefined()
    expect(validateSourceSpans([span("m1", "p1", 0, 10), span("m1", "p2", 0, 5)])).toBeUndefined()
  })
  test("rejects out-of-bounds spans", () => {
    expect(validateSourceSpans([span("m1", "p1", 5, 5)])).toBe("invalid-reference")
    expect(validateSourceSpans([span("m1", "p1", -1, 5)])).toBe("invalid-reference")
  })
  test("rejects overlapping spans within a part", () => {
    expect(validateSourceSpans([span("m1", "p1", 0, 10), span("m1", "p1", 5, 15)])).toBe("invalid-reference")
  })
  test("rejects unordered spans", () => {
    expect(validateSourceSpans([span("m1", "p1", 10, 20), span("m1", "p1", 0, 5)])).toBe("invalid-reference")
  })
})

describe("validateClaim / validateClaimSet", () => {
  test("scope is mandatory", () => {
    expect(validateClaim(claim("c1", { scope: "" }))).toBe("invalid-reference")
  })
  test("a claim needs at least one source span", () => {
    expect(validateClaim(claim("c1", { sources: [] }))).toBe("invalid-reference")
  })
  test("rejects duplicate ids and dangling supersedes", () => {
    expect(validateClaimSet([claim("c1"), claim("c1")])).toBe("invalid-reference")
    expect(validateClaimSet([claim("c1", { supersedes: "ghost" })])).toBe("invalid-reference")
    expect(validateClaimSet([claim("c1", { supersedes: "c1" })])).toBe("invalid-reference")
  })
  test("accepts a resolvable supersedes edge; the target keeps its identity", () => {
    const superseded = claim("c0", { text: "采用方案 B", status: "unverified" })
    const successor = claim("c1", { supersedes: "c0" })
    expect(validateClaimSet([superseded, successor])).toBeUndefined()
  })
})

describe("claimEquivalence", () => {
  test("matches on kind, text, scope, and source set", () => {
    expect(claimEquivalence(claim("c1"), claim("c2"))).toBe(true)
  })
  test("a narrower scope is not equivalent", () => {
    expect(claimEquivalence(claim("c1"), claim("c2", { scope: "仅 Linux" }))).toBe(false)
  })
})

describe("validateCoverage", () => {
  const spans = [span("m1", "p1", 0, 10), span("m1", "p1", 10, 20)]
  const claims = [claim("c1", { sources: [spans[0]] })]
  test("every span covered exactly once is accepted", () => {
    const coverage: CoverageEntry[] = [
      { source: spans[0], action: "keep", claimID: "c1" },
      { source: spans[1], action: "preserve" },
    ]
    expect(validateCoverage(coverage, spans, claims)).toBeUndefined()
  })
  test("an uncovered span violates the retention contract", () => {
    const coverage: CoverageEntry[] = [{ source: spans[0], action: "keep", claimID: "c1" }]
    expect(validateCoverage(coverage, spans, claims)).toBe("retention-contract-violated")
  })
  test("keep must resolve to a known claim, merge to a known witness", () => {
    expect(validateCoverage([{ source: spans[0], action: "keep", claimID: "ghost" }], [spans[0]], claims)).toBe(
      "invalid-reference",
    )
    expect(
      validateCoverage([{ source: spans[0], action: "merge", witness: span("m9", "p9", 0, 1) }], [spans[0]], claims),
    ).toBe("invalid-reference")
  })
  test("drop needs a non-empty reason", () => {
    expect(validateCoverage([{ source: spans[0], action: "drop", reason: "" }], [spans[0]], claims)).toBe(
      "retention-contract-violated",
    )
  })
  test("coverage may not reference a span outside R", () => {
    expect(validateCoverage([{ source: span("m9", "p9", 0, 1), action: "preserve" }], spans, claims)).toBe(
      "invalid-reference",
    )
  })
})

describe("resolveExecutionMatch (§5.5.1)", () => {
  test("a required compute tool with only read in inventory is absent", () => {
    const match = resolveExecutionMatch(target({ toolName: "bash" }), evidence([], [call("c1", "read", "completed")]))
    expect(match.kind).toBe("absent")
  })
  test("selector call picks the exact callID, never a substitute", () => {
    const match = resolveExecutionMatch(
      target({ selector: { kind: "call", callID: "c1" } }),
      evidence([], [call("c1", "bash", "error"), call("c2", "bash", "completed")]),
    )
    expect(match).toMatchObject({ kind: "matched" })
    if (match.kind === "matched") expect(match.calls.map((c) => c.ref.callID)).toEqual(["c1"])
  })
  test("unsettled scope is unknown, not absent (P4 in-flight protection)", () => {
    const match = resolveExecutionMatch(
      target({ scope: { messageIDs: ["m1"], stepIDs: [], settled: false } }),
      evidence([]),
    )
    expect(match).toEqual({ kind: "unknown", reason: "unsettled-scope" })
  })
  test("an incomplete inventory cannot prove absence", () => {
    const match = resolveExecutionMatch(target(), evidence([], [], false))
    expect(match).toEqual({ kind: "unknown", reason: "incomplete-inventory" })
  })
  test("all without a determined finite target set is ambiguous", () => {
    const match = resolveExecutionMatch(
      target({ selector: { kind: "all" } }),
      evidence([], [call("c1", "bash", "completed")]),
    )
    expect(match).toEqual({ kind: "unknown", reason: "ambiguous-target" })
  })
})

describe("resolveExecutionVerdict (§5.5.2 / §6.1)", () => {
  const matchOf = (t: ExecutionTarget, calls: CallObservation[], complete = true) =>
    resolveExecutionMatch(t, evidence([], calls, complete))

  test("required compute tool, only read called -> simulated_execution", () => {
    const t = target({ toolName: "bash" })
    const finding = resolveExecutionVerdict({
      target: t,
      match: matchOf(t, [call("c1", "read", "completed")]),
      sourceStatesFailure: false,
      support: { verdict: "unknown", reasonCode: "n/a" },
    })
    expect(finding?.kind).toBe("simulated_execution")
  })
  test("matched call truly failed but source claims success -> unbacked_completion", () => {
    const t = target({ selector: { kind: "call", callID: "c1" } })
    const finding = resolveExecutionVerdict({
      target: t,
      match: matchOf(t, [call("c1", "bash", "error")]),
      sourceStatesFailure: false,
      support: { verdict: "supported", method: "deterministic" },
    })
    expect(finding?.kind).toBe("unbacked_completion")
  })
  test("c1 failed, c2 succeeded: at-least-one success is supported by c2", () => {
    const t = target({ selector: { kind: "at-least-one" } })
    const finding = resolveExecutionVerdict({
      target: t,
      match: matchOf(t, [call("c1", "bash", "error"), call("c2", "bash", "completed")]),
      sourceStatesFailure: false,
      support: { verdict: "supported", method: "deterministic" },
    })
    expect(finding).toBeUndefined()
  })
  test("matched failure honestly reported by the source -> no violation", () => {
    const t = target({ selector: { kind: "call", callID: "c1" } })
    const finding = resolveExecutionVerdict({
      target: t,
      match: matchOf(t, [call("c1", "bash", "error")]),
      sourceStatesFailure: true,
      support: { verdict: "unknown", reasonCode: "n/a" },
    })
    expect(finding).toBeUndefined()
  })
  test("pending/running call -> unverifiable, never treated as success", () => {
    const t = target({ selector: { kind: "call", callID: "c1" } })
    const finding = resolveExecutionVerdict({
      target: t,
      match: matchOf(t, [call("c1", "bash", "running")]),
      sourceStatesFailure: false,
      support: { verdict: "unknown", reasonCode: "n/a" },
    })
    expect(finding?.kind).toBe("unverifiable")
  })
  test("truncated body with complete status: support-dependent claim is unverifiable", () => {
    const t = target({ selector: { kind: "call", callID: "c1" } })
    const finding = resolveExecutionVerdict({
      target: t,
      match: matchOf(t, [call("c1", "bash", "completed", "truncated")]),
      sourceStatesFailure: false,
      support: { verdict: "unknown", reasonCode: "body-truncated" },
    })
    expect(finding?.kind).toBe("unverifiable")
  })
  test("incomplete inventory with no match -> unverifiable, not absent", () => {
    const t = target()
    const finding = resolveExecutionVerdict({
      target: t,
      match: matchOf(t, [], false),
      sourceStatesFailure: false,
      support: { verdict: "unknown", reasonCode: "n/a" },
    })
    expect(finding?.kind).toBe("unverifiable")
  })
})

describe("planReasoningDistillation (§5.2)", () => {
  test("auxiliary purpose never distills", () => {
    expect(planReasoningDistillation(planInput({ purpose: "auxiliary" }))).toMatchObject({
      skipReason: "no-rewritable-slot",
      extraCall: "none",
    })
  })
  test("the trigger is overBudget === true; unknown budget does not fire", () => {
    expect(planReasoningDistillation(planInput({ budget: budget(false) }))).toMatchObject({
      skipReason: "below-target",
    })
    expect(planReasoningDistillation(planInput({ budget: budget(undefined) }))).toMatchObject({
      skipReason: "below-target",
    })
  })
  test("no rewritable slot vs compatibility-unproven (P5)", () => {
    expect(planReasoningDistillation(planInput({ mappings: [protectedMapping("P1")] }))).toMatchObject({
      skipReason: "no-rewritable-slot",
    })
    expect(planReasoningDistillation(planInput({ mappings: [protectedMapping("P5")] }))).toMatchObject({
      skipReason: "compatibility-unproven",
    })
  })
  test("no candidate requests one propose call, bounded by quota", () => {
    expect(planReasoningDistillation(planInput())).toMatchObject({ extraCall: "propose", replacements: [] })
    expect(planReasoningDistillation(planInput({ quota: { proposeUsed: true, judgeUsed: false } }))).toMatchObject({
      skipReason: "call-budget-exhausted",
    })
  })
  test("a candidate under a different policy version is stale", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const cand = candidate([claim("c1", { sources: spans })], [{ source: spans[0], action: "keep", claimID: "c1" }], {
      key: {
        sessionID: "s1",
        messageID: "m1",
        partIDs: ["p1"],
        sourceFingerprint: "sf1",
        capabilityFingerprint: "cap1",
        organizerFingerprint: "org1",
        policyVersion: "other-v0",
      },
    })
    expect(planReasoningDistillation(planInput({ candidate: cand, evidence: evidence(spans) }))).toMatchObject({
      skipReason: "stale-validation",
    })
  })
  test("a claim whose source is not in R is a new assertion (G1)", () => {
    const rSpans = [span("m1", "p1", 0, 10)]
    const foreign = span("m2", "p9", 0, 5)
    const cand = candidate([claim("c1", { sources: [foreign] })], [{ source: rSpans[0], action: "preserve" }])
    expect(planReasoningDistillation(planInput({ candidate: cand, evidence: evidence(rSpans) }))).toMatchObject({
      skipReason: "new-assertion",
    })
  })
  test("incomplete coverage violates the retention contract (G2)", () => {
    const spans = [span("m1", "p1", 0, 10), span("m1", "p1", 10, 20)]
    const cand = candidate(
      [claim("c1", { sources: [spans[0]] })],
      [{ source: spans[0], action: "keep", claimID: "c1" }],
    )
    expect(planReasoningDistillation(planInput({ candidate: cand, evidence: evidence(spans) }))).toMatchObject({
      skipReason: "retention-contract-violated",
    })
  })
  test("an evidence ref that does not resolve is evidence-unresolved (G3)", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const cand = candidate(
      [claim("c1", { sources: spans, evidence: [{ messageID: "m9", partID: "p9", kind: "source" }] })],
      [{ source: spans[0], action: "keep", claimID: "c1" }],
    )
    expect(planReasoningDistillation(planInput({ candidate: cand, evidence: evidence(spans) }))).toMatchObject({
      skipReason: "evidence-unresolved",
    })
  })
  test("a verified claim without support defers to judge, then skips when quota is gone", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const cand = candidate([claim("c1", { sources: spans })], [{ source: spans[0], action: "keep", claimID: "c1" }])
    const base = { candidate: cand, evidence: evidence(spans) }
    expect(planReasoningDistillation(planInput(base))).toMatchObject({ extraCall: "judge", replacements: [] })
    expect(
      planReasoningDistillation(planInput({ ...base, quota: { proposeUsed: true, judgeUsed: true } })),
    ).toMatchObject({ skipReason: "semantic-review-required" })
  })
  test("contradicted support rejects the candidate", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const cand = candidate([claim("c1", { sources: spans })], [{ source: spans[0], action: "keep", claimID: "c1" }])
    const support: ClaimSupport[] = [{ claimID: "c1", result: { verdict: "contradicted", method: "judged" } }]
    expect(planReasoningDistillation(planInput({ candidate: cand, evidence: evidence(spans), support }))).toMatchObject(
      { skipReason: "evidence-unresolved" },
    )
  })
  test("a judged stamp requires the judge fingerprint", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const cand = candidate([claim("c1", { sources: spans })], [{ source: spans[0], action: "keep", claimID: "c1" }])
    const support: ClaimSupport[] = [{ claimID: "c1", result: { verdict: "supported", method: "judged" } }]
    expect(planReasoningDistillation(planInput({ candidate: cand, evidence: evidence(spans), support }))).toMatchObject(
      { skipReason: "stale-validation" },
    )
  })
  test("deterministically supported candidate is applied with positive savings", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const cand = candidate([claim("c1", { sources: spans })], [{ source: spans[0], action: "keep", claimID: "c1" }])
    const support: ClaimSupport[] = [{ claimID: "c1", result: supported("deterministic") }]
    const plan = planReasoningDistillation(
      planInput({ candidate: cand, evidence: evidence(spans), support, originalTokens: 1000 }),
    )
    expect(plan.skipReason).toBeUndefined()
    expect(plan.extraCall).toBe("none")
    expect(plan.replacements).toHaveLength(1)
    expect(plan.replacements[0].validation.method).toBe("deterministic")
    expect(plan.replacements[0].estimatedSavings).toBeGreaterThan(0)
    expect(plan.replacements[0].projection.text).toContain("采用方案 A")
  })
  test("a judged-supported candidate carries the judge fingerprint on its stamp", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const cand = candidate([claim("c1", { sources: spans })], [{ source: spans[0], action: "keep", claimID: "c1" }])
    const support: ClaimSupport[] = [{ claimID: "c1", result: supported("judged") }]
    const plan = planReasoningDistillation(
      planInput({ candidate: cand, evidence: evidence(spans), support, judgeFingerprint: "judge-1" }),
    )
    expect(plan.replacements[0].validation).toMatchObject({ method: "judged", judgeFingerprint: "judge-1" })
  })
  test("non-positive savings skips the projection", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const cand = candidate([claim("c1", { sources: spans })], [{ source: spans[0], action: "keep", claimID: "c1" }])
    const support: ClaimSupport[] = [{ claimID: "c1", result: supported("deterministic") }]
    expect(
      planReasoningDistillation(planInput({ candidate: cand, evidence: evidence(spans), support, originalTokens: 1 })),
    ).toMatchObject({ skipReason: "insufficient-net-savings" })
  })
  test("an unknown original-token count cannot pass the savings gate", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const cand = candidate([claim("c1", { sources: spans })], [{ source: spans[0], action: "keep", claimID: "c1" }])
    const support: ClaimSupport[] = [{ claimID: "c1", result: supported("deterministic") }]
    expect(
      planReasoningDistillation(
        planInput({ candidate: cand, evidence: evidence(spans), support, originalTokens: undefined }),
      ),
    ).toMatchObject({ skipReason: "unknown-content" })
  })
})

describe("spanKey", () => {
  test("distinguishes spans by fingerprint", () => {
    expect(spanKey(span("m1", "p1", 0, 10, "a"))).not.toBe(spanKey(span("m1", "p1", 0, 10, "b")))
  })
})
