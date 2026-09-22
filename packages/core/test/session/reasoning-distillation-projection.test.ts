import { describe, expect, test } from "bun:test"
import { fingerprintContextFoldingRequest, type PreparedRequestBudgetInput } from "../../src/session/context-folding"
import {
  capabilityFingerprint,
  classifySlotEligibility,
  projectDistillationRequest,
  type CompatibilityRecord,
  type DistillationPlanReplacement,
  type SlotAssessment,
  type SlotCapability,
} from "../../src/session/reasoning-distillation"
import { Hash } from "../../src/util/hash"

const budgetInput = (messages: unknown): PreparedRequestBudgetInput => ({
  contextLimit: 1_000,
  inputLimit: { kind: "absent" },
  outputReserve: 100,
  system: { kind: "none" },
  messages,
  tools: [],
  protocolOverheadTokens: 0,
  media: "none",
})

const requestFingerprint = (request: unknown, identity: unknown, budget: PreparedRequestBudgetInput): string => {
  const fingerprint = fingerprintContextFoldingRequest({ request, identity, budget })
  if (!fingerprint.ok) throw new Error(`fingerprint failed: ${fingerprint.reason}`)
  return fingerprint.value
}

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

const slot = (overrides: Partial<SlotAssessment> = {}): SlotAssessment => ({
  shape: "interleaved-field",
  capability: capability(),
  signed: false,
  encrypted: false,
  settled: true,
  structureRewritable: true,
  ...overrides,
})

describe("classifySlotEligibility (§2.1)", () => {
  test("protection classes take priority over an authorized record", () => {
    const records = [record()]
    expect(classifySlotEligibility(slot({ signed: true }), records)).toEqual({ allowed: false, protection: "P1" })
    expect(classifySlotEligibility(slot({ encrypted: true }), records)).toEqual({ allowed: false, protection: "P2" })
    expect(classifySlotEligibility(slot({ settled: false }), records)).toEqual({ allowed: false, protection: "P4" })
    expect(classifySlotEligibility(slot({ structureRewritable: false }), records)).toEqual({
      allowed: false,
      protection: "P3",
    })
  })

  test("an otherwise-safe slot without a compatibility record stays P5 (default-on still protected)", () => {
    expect(classifySlotEligibility(slot(), [])).toEqual({ allowed: false, protection: "P5" })
  })

  test("a mock-only record (no real upstream) does not authorize rewriting", () => {
    expect(classifySlotEligibility(slot(), [record({ upstreamVerified: false })])).toEqual({
      allowed: false,
      protection: "P5",
    })
    expect(classifySlotEligibility(slot(), [record({ transportVerified: false })])).toEqual({
      allowed: false,
      protection: "P5",
    })
  })

  test("a record for a different capability does not authorize this slot", () => {
    const other = record({ providerModelVariant: "other/model" })
    expect(classifySlotEligibility(slot(), [other])).toEqual({ allowed: false, protection: "P5" })
  })

  test("a fully authorized matching record allows rewriting with a stable capability fingerprint", () => {
    const eligibility = classifySlotEligibility(slot(), [record()])
    expect(eligibility.allowed).toBe(true)
    if (eligibility.allowed) expect(eligibility.capabilityFingerprint).toBe(capabilityFingerprint(capability()))
  })

  test("capabilityFingerprint is stable and changes with the capability tuple", () => {
    expect(capabilityFingerprint(capability())).toBe(capabilityFingerprint(capability()))
    expect(capabilityFingerprint(capability())).not.toBe(
      capabilityFingerprint(capability({ endpointIdentity: "endpoint-2" })),
    )
  })
})

type WireRequest = { messages: Array<{ role: string; reasoning?: string }>; metadata: { mutable: string } }

const distillationReplacement = (
  bodyPath: readonly (string | number)[],
  sourceFingerprint: string,
  text: string,
  allowed = true,
): DistillationPlanReplacement => ({
  mapping: {
    refs: [{ messageID: "m1", partID: "p1" }],
    shape: "interleaved-field",
    eligibility: allowed ? { allowed: true, capabilityFingerprint: "cap1" } : { allowed: false, protection: "P5" },
    bodyPath,
    sourceFingerprint,
  },
  projection: { claims: [], preserved: [], text },
  validation: {
    candidateFingerprint: "cf1",
    evidenceFingerprint: "ef1",
    capabilityFingerprint: "cap1",
    validatorVersion: "gates-v1",
    method: "deterministic",
  },
  estimatedSavings: 100,
})

const fixture = (body: string) => {
  const request: WireRequest = { messages: [{ role: "assistant", reasoning: body }], metadata: { mutable: "original" } }
  const identity = { model: "test-model", runtime: "test-runtime" }
  const budget = budgetInput(request.messages)
  return { request, identity, budget, fingerprint: requestFingerprint(request, identity, budget) }
}

describe("projectDistillationRequest (§5.2)", () => {
  const original = "原始冗长思绪".repeat(20)
  const distilled = "精简结论"

  test("applies the projection to a private copy, leaving the original object untouched", () => {
    const { request, identity, budget, fingerprint } = fixture(original)
    const result = projectDistillationRequest<WireRequest>({
      request,
      identity,
      expectedRequestFingerprint: fingerprint,
      budget,
      replacements: [distillationReplacement(["messages", 0, "reasoning"], Hash.sha256(original), distilled)],
    })
    expect(result.applied).toBe(true)
    expect(result.request.messages[0].reasoning).toBe(distilled)
    // The original request object is never mutated.
    expect(request.messages[0].reasoning).toBe(original)
    expect(result.request).not.toBe(request)
  })

  test("a changed request fingerprint is stale and returns the same original object", () => {
    const { request, identity, budget } = fixture(original)
    const result = projectDistillationRequest<WireRequest>({
      request,
      identity,
      expectedRequestFingerprint: "stale-fingerprint",
      budget,
      replacements: [distillationReplacement(["messages", 0, "reasoning"], Hash.sha256(original), distilled)],
    })
    expect(result).toMatchObject({ applied: false, skipReason: "stale-request" })
    expect(result.request).toBe(request)
  })

  test("source-fingerprint binding gives idempotency: a second projection of the same request is stale", () => {
    const { request, identity, budget, fingerprint } = fixture(original)
    const first = projectDistillationRequest<WireRequest>({
      request,
      identity,
      expectedRequestFingerprint: fingerprint,
      budget,
      replacements: [distillationReplacement(["messages", 0, "reasoning"], Hash.sha256(original), distilled)],
    })
    expect(first.applied).toBe(true)
    // Re-projecting the already-projected request with the same source fingerprint must not double-wrap.
    const secondFingerprint = requestFingerprint(first.request, identity, budget)
    const second = projectDistillationRequest<WireRequest>({
      request: first.request,
      identity,
      expectedRequestFingerprint: secondFingerprint,
      budget,
      replacements: [distillationReplacement(["messages", 0, "reasoning"], Hash.sha256(original), distilled)],
    })
    expect(second).toMatchObject({ applied: false, skipReason: "stale-validation" })
  })

  test("an ineligible slot is never rewritten", () => {
    const { request, identity, budget, fingerprint } = fixture(original)
    const result = projectDistillationRequest<WireRequest>({
      request,
      identity,
      expectedRequestFingerprint: fingerprint,
      budget,
      replacements: [distillationReplacement(["messages", 0, "reasoning"], Hash.sha256(original), distilled, false)],
    })
    expect(result).toMatchObject({ applied: false, skipReason: "no-rewritable-slot" })
    expect(result.request).toBe(request)
  })

  test("two replacements colliding on one body path are rejected", () => {
    const { request, identity, budget, fingerprint } = fixture(original)
    const result = projectDistillationRequest<WireRequest>({
      request,
      identity,
      expectedRequestFingerprint: fingerprint,
      budget,
      replacements: [
        distillationReplacement(["messages", 0, "reasoning"], Hash.sha256(original), distilled),
        distillationReplacement(["messages", 0, "reasoning"], Hash.sha256(original), distilled),
      ],
    })
    expect(result).toMatchObject({ applied: false, skipReason: "mapping-mismatch" })
  })

  test("a non-positive saving skips the projection", () => {
    const short = "abc"
    const { request, identity, budget, fingerprint } = fixture(short)
    const result = projectDistillationRequest<WireRequest>({
      request,
      identity,
      expectedRequestFingerprint: fingerprint,
      budget,
      replacements: [
        distillationReplacement(["messages", 0, "reasoning"], Hash.sha256(short), "a much longer replacement body"),
      ],
    })
    expect(result).toMatchObject({ applied: false, skipReason: "insufficient-net-savings" })
  })
})
