import { describe, expect, test } from "bun:test"
import type { PreparedRequestBudgetInput } from "@opencode-ai/core/session/context-folding"
import {
  ReasoningDistillationPolicy,
  type Candidate,
  type ClaimSupport,
  type CompatibilityRecord,
  type DistillationCallQuota,
  type SlotCapability,
  type SourceSpan,
} from "@opencode-ai/core/session/reasoning-distillation"
import { Hash } from "@opencode-ai/core/util/hash"
import {
  buildReasoningEvidence,
  buildSlotMappings,
  projectDistillationAISDK,
  type ReasoningSlotObservation,
  type ToolCallObservation,
} from "../../src/session/reasoning-distillation"

const slot = (overrides: Partial<ReasoningSlotObservation> = {}): ReasoningSlotObservation => ({
  messageID: "m1",
  partID: "p1",
  bodyPath: ["messages", 0, "reasoning"],
  text: "原始冗长思绪",
  shape: "interleaved-field",
  signed: false,
  encrypted: false,
  settled: true,
  structureRewritable: true,
  ...overrides,
})

const call = (overrides: Partial<ToolCallObservation> = {}): ToolCallObservation => ({
  messageID: "m1",
  partID: "tp1",
  callID: "c1",
  toolName: "bash",
  status: "completed",
  result: "complete",
  provenance: "corroborated",
  ...overrides,
})

const capability = (overrides: Partial<SlotCapability> = {}): SlotCapability => ({
  runtime: "opencode-ai-sdk",
  protocol: "openai-compatible",
  providerModelVariant: "local-proxy-compatible/deepseek",
  endpointIdentity: "endpoint-1",
  adapterVersion: "adapter-v1",
  optionsFingerprint: "opts-1",
  ...overrides,
})

const record = (overrides: Partial<CompatibilityRecord> = {}): CompatibilityRecord => ({
  ...capability(),
  transportVerified: true,
  upstreamVerified: true,
  ...overrides,
})

describe("buildReasoningEvidence", () => {
  test("emits part-level spans ordered by (messageID, partID), fingerprinted to the exact text", () => {
    const evidence = buildReasoningEvidence(
      [slot({ messageID: "m2", partID: "p1", text: "second" }), slot({ messageID: "m1", partID: "p1", text: "first" })],
      [],
      true,
      "inv1",
    )
    expect(evidence.spans.map((s) => s.messageID)).toEqual(["m1", "m2"])
    expect(evidence.spans[0]).toEqual({
      messageID: "m1",
      partID: "p1",
      start: 0,
      end: 5,
      fingerprint: Hash.sha256("first"),
    })
    expect(evidence.inventoryComplete).toBe(true)
    expect(evidence.inventoryFingerprint).toBe("inv1")
  })

  test("maps tool calls to authoritative observations, omitting an absent input fingerprint", () => {
    const evidence = buildReasoningEvidence([], [call()], true, "inv1")
    expect(evidence.calls[0]).toEqual({
      ref: { messageID: "m1", partID: "tp1", callID: "c1", kind: "tool-result" },
      toolName: "bash",
      status: "completed",
      result: "complete",
      provenance: "corroborated",
    })
    expect("inputFingerprint" in evidence.calls[0]).toBe(false)
  })

  test("preserves a supplied input fingerprint and an incomplete-inventory flag", () => {
    const evidence = buildReasoningEvidence(
      [],
      [call({ inputFingerprint: "fp1", provenance: "unavailable" })],
      false,
      "inv2",
    )
    expect(evidence.calls[0].inputFingerprint).toBe("fp1")
    expect(evidence.calls[0].provenance).toBe("unavailable")
    expect(evidence.inventoryComplete).toBe(false)
  })
})

describe("buildSlotMappings (§2.1 gating)", () => {
  test("without a compatibility record every slot is P5-protected (default-on still a no-op)", () => {
    const mappings = buildSlotMappings([slot()], capability(), [])
    expect(mappings[0].eligibility).toEqual({ allowed: false, protection: "P5" })
    expect(mappings[0].sourceFingerprint).toBe(Hash.sha256("原始冗长思绪"))
    expect(mappings[0].bodyPath).toEqual(["messages", 0, "reasoning"])
    expect(mappings[0].refs).toEqual([{ messageID: "m1", partID: "p1" }])
  })

  test("a dual-evidence matching record authorizes rewriting", () => {
    const mappings = buildSlotMappings([slot()], capability(), [record()])
    expect(mappings[0].eligibility.allowed).toBe(true)
  })

  test("protection outranks an authorized record (signed slot stays P1)", () => {
    const mappings = buildSlotMappings([slot({ signed: true })], capability(), [record()])
    expect(mappings[0].eligibility).toEqual({ allowed: false, protection: "P1" })
  })

  test("a mock-only record does not authorize rewriting", () => {
    const mappings = buildSlotMappings([slot()], capability(), [record({ upstreamVerified: false })])
    expect(mappings[0].eligibility).toEqual({ allowed: false, protection: "P5" })
  })
})

const POLICY = ReasoningDistillationPolicy.version
const TEXT = "原始冗长思绪".repeat(20)

const wireRequest = (text: string) => ({
  messages: [{ role: "assistant", reasoning: text }],
  metadata: { mutable: "original" },
})

const overBudgetInput = (messages: unknown): PreparedRequestBudgetInput => ({
  contextLimit: 40,
  inputLimit: { kind: "absent" },
  outputReserve: 5,
  system: { kind: "none" },
  messages,
  tools: [],
  protocolOverheadTokens: 0,
  media: "none",
})

const spanFor = (text: string): SourceSpan => ({
  messageID: "m1",
  partID: "p1",
  start: 0,
  end: text.length,
  fingerprint: Hash.sha256(text),
})

const validCandidate = (text: string): Candidate => {
  const s = spanFor(text)
  return {
    key: {
      sessionID: "s1",
      messageID: "m1",
      partIDs: ["p1"],
      sourceFingerprint: "sf1",
      capabilityFingerprint: "cap1",
      organizerFingerprint: "org1",
      policyVersion: POLICY,
    },
    fingerprint: "cand1",
    claims: [
      {
        id: "c1",
        kind: "decision",
        text: "精简结论",
        scope: "本次会话",
        sources: [s],
        evidence: [{ messageID: "m1", partID: "p1", kind: "source" }],
        status: "verified",
      },
    ],
    preserved: [],
    coverage: [{ source: s, action: "keep", claimID: "c1" }],
  }
}

const deterministicSupport: ClaimSupport[] = [
  { claimID: "c1", result: { verdict: "supported", method: "deterministic" } },
]
const exhaustedQuota: DistillationCallQuota = { proposeUsed: true, judgeUsed: true }
const freshQuota: DistillationCallQuota = { proposeUsed: false, judgeUsed: false }

const baseInput = (
  request: ReturnType<typeof wireRequest>,
  overrides: Partial<Parameters<typeof projectDistillationAISDK<typeof request>>[0]> = {},
) => ({
  request,
  identity: { model: "m", runtime: "r" },
  purpose: "conversation" as const,
  budget: overBudgetInput(request.messages),
  slots: [slot({ text: TEXT })],
  calls: [],
  inventoryComplete: true,
  inventoryFingerprint: "inv1",
  capability: capability(),
  records: [record()],
  candidate: validCandidate(TEXT),
  support: deterministicSupport,
  quota: exhaustedQuota,
  originalTokens: 1000,
  ...overrides,
})

describe("projectDistillationAISDK (§5.2)", () => {
  test("without a compatibility record the slot is P5 and the request is returned unchanged", () => {
    const request = wireRequest(TEXT)
    const result = projectDistillationAISDK(baseInput(request, { records: [] }))
    expect(result.applied).toBe(false)
    expect(result.plan.skipReason).toBe("compatibility-unproven")
    expect(result.request).toBe(request)
  })

  test("an authorized slot with a deterministically supported cached candidate projects onto a private copy", () => {
    const request = wireRequest(TEXT)
    const result = projectDistillationAISDK(baseInput(request))
    expect(result.applied).toBe(true)
    expect(result.request.messages[0].reasoning).toContain("精简结论")
    expect(request.messages[0].reasoning).toBe(TEXT)
    expect(result.request).not.toBe(request)
  })

  test("no cached candidate defers to one propose call and sends the original", () => {
    const request = wireRequest(TEXT)
    const result = projectDistillationAISDK(
      baseInput(request, { candidate: undefined, support: [], quota: freshQuota }),
    )
    expect(result.applied).toBe(false)
    expect(result.plan.extraCall).toBe("propose")
    expect(result.request).toBe(request)
  })

  test("below the budget trigger nothing is rewritten", () => {
    const request = wireRequest(TEXT)
    const result = projectDistillationAISDK(
      baseInput(request, { budget: { ...overBudgetInput(request.messages), contextLimit: 100_000 } }),
    )
    expect(result.applied).toBe(false)
    expect(result.plan.skipReason).toBe("below-target")
    expect(result.request).toBe(request)
  })
})
