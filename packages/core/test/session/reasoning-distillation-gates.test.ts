import { describe, expect, test } from "bun:test"
import type { ContextFoldingBudget } from "../../src/session/context-folding"
import {
  assembleAudit,
  evaluateGates,
  gateViolationToFinding,
  planReasoningDistillation,
  type AuditFinding,
  type CallObservation,
  type Candidate,
  type Claim,
  type ClaimSupport,
  type CoverageEntry,
  type DistillationPlanInput,
  type ExecutionTarget,
  type ExecutionVerdictContext,
  type ReasoningEvidence,
  type SourceSpan,
  type SupportResult,
  type WireReasoningMapping,
} from "../../src/session/reasoning-distillation"

const POLICY_VERSION = "reasoning-distillation-v1"

const span = (messageID: string, partID: string, start: number, end: number): SourceSpan => ({
  messageID,
  partID,
  start,
  end,
  fingerprint: `${messageID}:${partID}:${start}`,
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

const support = (claimID: string, result: SupportResult): ClaimSupport => ({ claimID, result })
const deterministic = (claimID: string): ClaimSupport =>
  support(claimID, { verdict: "supported", method: "deterministic" })

const budget = (overBudget: boolean | undefined): ContextFoldingBudget => ({
  usableInputTokens: 1000,
  targetTokens: 700,
  estimatedInputTokens: 900,
  overBudget,
  inputBytes: 4000,
  skipReason: undefined,
})

const eligibleMapping = (): WireReasoningMapping => ({
  refs: [{ messageID: "m1", partID: "p1" }],
  shape: "interleaved-field",
  eligibility: { allowed: true, capabilityFingerprint: "cap1" },
  bodyPath: ["messages", 0, "content"],
  sourceFingerprint: "sf1",
})

const call = (callID: string, toolName: string, status: CallObservation["status"]): CallObservation => ({
  ref: { messageID: "m1", partID: `part-${callID}`, callID, kind: "tool-result" },
  toolName,
  status,
  result: "complete",
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

const candidate = (claims: readonly Claim[], coverage: readonly CoverageEntry[]): Candidate => ({
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

const planInput = (overrides: Partial<DistillationPlanInput> = {}): DistillationPlanInput => ({
  purpose: "conversation",
  budget: budget(true),
  candidate: undefined,
  evidence: evidence([]),
  mappings: [eligibleMapping()],
  quota: { proposeUsed: true, judgeUsed: true },
  originalTokens: 1000,
  support: [],
  policyVersion: POLICY_VERSION,
  ...overrides,
})

/** A clean single-claim candidate over one R span, deterministically supported. */
const cleanFixture = () => {
  const spans = [span("m1", "p1", 0, 10)]
  const cand = candidate([claim("c1", { sources: spans })], [{ source: spans[0], action: "keep", claimID: "c1" }])
  return { spans, cand, support: [deterministic("c1")] }
}

describe("evaluateGates (§5.4)", () => {
  test("G1: a claim whose source is outside R is fabricated, regardless of status label", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const foreign = span("m2", "p9", 0, 5)
    // Marking the new proposition unverified/assumed must not bypass G1.
    const cand = candidate(
      [claim("c1", { sources: [foreign], status: "assumed" })],
      [{ source: spans[0], action: "preserve" }],
    )
    const result = evaluateGates(cand, evidence(spans), [])
    expect(result.skipReason).toBe("new-assertion")
    expect(result.violations.some((v) => v.gate === "G1" && v.kind === "fabricated")).toBe(true)
  })

  test("G2: an uncovered R span is concealed", () => {
    const spans = [span("m1", "p1", 0, 10), span("m1", "p1", 10, 20)]
    const cand = candidate(
      [claim("c1", { sources: [spans[0]] })],
      [{ source: spans[0], action: "keep", claimID: "c1" }],
    )
    const result = evaluateGates(cand, evidence(spans), [deterministic("c1")])
    expect(result.skipReason).toBe("retention-contract-violated")
    expect(result.violations.some((v) => v.gate === "G2" && v.kind === "concealed")).toBe(true)
  })

  test("G3: an evidence ref that does not resolve is evidence_swap", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const cand = candidate(
      [claim("c1", { sources: spans, evidence: [{ messageID: "m9", partID: "p9", kind: "source" }] })],
      [{ source: spans[0], action: "keep", claimID: "c1" }],
    )
    const result = evaluateGates(cand, evidence(spans), [deterministic("c1")])
    expect(result.skipReason).toBe("evidence-unresolved")
    expect(result.violations.some((v) => v.gate === "G3" && v.reasonCode === "g3-unresolved-evidence")).toBe(true)
  })

  test("G3: a later part proving an earlier assertion is a temporal mismatch", () => {
    const spans = [span("m1", "p1", 0, 10), span("m1", "p2", 0, 10)]
    const cand = candidate(
      [claim("c1", { sources: [spans[0]], evidence: [{ messageID: "m1", partID: "p2", kind: "tool-result" }] })],
      [
        { source: spans[0], action: "keep", claimID: "c1" },
        { source: spans[1], action: "preserve" },
      ],
    )
    const result = evaluateGates(cand, evidence(spans), [deterministic("c1")])
    expect(result.skipReason).toBe("evidence-unresolved")
    expect(result.violations.some((v) => v.gate === "G3" && v.reasonCode === "g3-future-evidence")).toBe(true)
  })

  test("G4: contradicted support is evidence_swap", () => {
    const { spans, cand } = cleanFixture()
    const result = evaluateGates(cand, evidence(spans), [support("c1", { verdict: "contradicted", method: "judged" })])
    expect(result.skipReason).toBe("evidence-unresolved")
    expect(result.violations.some((v) => v.gate === "G4" && v.kind === "evidence_swap")).toBe(true)
  })

  test("a verified claim without support needs semantic review, with no terminal violation", () => {
    const { spans, cand } = cleanFixture()
    const result = evaluateGates(cand, evidence(spans), [])
    expect(result.needsSemanticReview).toBe(true)
    expect(result.skipReason).toBeUndefined()
    expect(result.violations).toHaveLength(0)
  })

  test("judge-produced support sets anyJudged and needs no further review", () => {
    const { spans, cand } = cleanFixture()
    const result = evaluateGates(cand, evidence(spans), [support("c1", { verdict: "supported", method: "judged" })])
    expect(result.anyJudged).toBe(true)
    expect(result.needsSemanticReview).toBe(false)
    expect(result.skipReason).toBeUndefined()
  })

  test("a user-given constraint supported by instruction evidence passes without a completed tool", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const cand = candidate(
      [
        claim("c1", {
          kind: "constraint",
          sources: spans,
          evidence: [{ messageID: "m1", partID: "p1", kind: "instruction" }],
        }),
      ],
      [{ source: spans[0], action: "keep", claimID: "c1" }],
    )
    const result = evaluateGates(cand, evidence(spans), [deterministic("c1")])
    expect(result.skipReason).toBeUndefined()
    expect(result.violations).toHaveLength(0)
    expect(result.needsSemanticReview).toBe(false)
  })

  test("a clean, deterministically supported candidate passes all gates", () => {
    const { spans, cand, support: sup } = cleanFixture()
    const result = evaluateGates(cand, evidence(spans), sup)
    expect(result).toMatchObject({ needsSemanticReview: false, anyJudged: false, skipReason: undefined })
    expect(result.violations).toHaveLength(0)
  })
})

describe("audit assembly (§5.5)", () => {
  test("gateViolationToFinding drops the gate id and keeps the diagnostic fields", () => {
    const finding = gateViolationToFinding({
      gate: "G1",
      kind: "fabricated",
      claimID: "c1",
      evidence: [{ messageID: "m1", partID: "p1", kind: "source" }],
      confidence: "deterministic",
      reasonCode: "g1-unbound-source",
    })
    expect(finding).toEqual({
      kind: "fabricated",
      claimID: "c1",
      evidence: [{ messageID: "m1", partID: "p1", kind: "source" }],
      confidence: "deterministic",
      reasonCode: "g1-unbound-source",
    })
  })

  test("assembleAudit attributes execution findings to source-agent and gate findings to distiller", () => {
    const exec: AuditFinding = {
      kind: "simulated_execution",
      targetID: "t1",
      evidence: [],
      confidence: "deterministic",
      reasonCode: "execution-absent",
    }
    const distiller: AuditFinding = {
      kind: "fabricated",
      claimID: "c1",
      evidence: [],
      confidence: "deterministic",
      reasonCode: "g1-unbound-source",
    }
    const records = assembleAudit([exec], [distiller])
    expect(records).toEqual([
      { subject: "source-agent", findings: [exec] },
      { subject: "distiller", findings: [distiller] },
    ])
  })

  test("assembleAudit omits empty subjects", () => {
    expect(assembleAudit([], [])).toEqual([])
    expect(
      assembleAudit([], [{ kind: "concealed", evidence: [], confidence: "deterministic", reasonCode: "g2" }]),
    ).toEqual([
      {
        subject: "distiller",
        findings: [{ kind: "concealed", evidence: [], confidence: "deterministic", reasonCode: "g2" }],
      },
    ])
  })
})

describe("plan execution-target audit integration (§5.5)", () => {
  test("a faithful projection still records source-agent execution fraud separately", () => {
    const { spans, cand, support: sup } = cleanFixture()
    const targets = [target({ toolName: "bash" })]
    const executionContext: ExecutionVerdictContext[] = [
      { targetID: "t1", sourceStatesFailure: false, support: { verdict: "unknown", reasonCode: "n/a" } },
    ]
    // Inventory has only a read call, so the required bash target is absent -> simulated_execution.
    const plan = planReasoningDistillation(
      planInput({
        candidate: cand,
        evidence: evidence(spans, [call("c1", "read", "completed")]),
        support: sup,
        targets,
        executionContext,
      }),
    )
    expect(plan.skipReason).toBeUndefined()
    expect(plan.replacements).toHaveLength(1)
    const sourceAgent = plan.audit.find((record) => record.subject === "source-agent")
    expect(sourceAgent?.findings.some((f) => f.kind === "simulated_execution")).toBe(true)
    // The projection text carries only claim/provenance content, never the audit reason code (§5.5.3 isolation).
    expect(plan.replacements[0].projection.text).not.toContain("execution-absent")
  })

  test("a rejected candidate still emits its distiller findings", () => {
    const spans = [span("m1", "p1", 0, 10)]
    const foreign = span("m2", "p9", 0, 5)
    const cand = candidate([claim("c1", { sources: [foreign] })], [{ source: spans[0], action: "preserve" }])
    const plan = planReasoningDistillation(
      planInput({ candidate: cand, evidence: evidence(spans), support: [deterministic("c1")] }),
    )
    expect(plan.skipReason).toBe("new-assertion")
    expect(plan.replacements).toHaveLength(0)
    const distiller = plan.audit.find((record) => record.subject === "distiller")
    expect(distiller?.findings.some((f) => f.kind === "fabricated")).toBe(true)
  })
})
