import { describe, expect, test } from "bun:test"
import type { PreparedRequestBudgetInput } from "@opencode-ai/core/session/context-folding"
import {
  ReasoningDistillationPolicy,
  capabilityFingerprint,
  type Candidate,
  type ClaimSupport,
  type CompatibilityRecord,
  type DistillationCallQuota,
  type DistillationKey,
  type SlotCapability,
  type SourceSpan,
} from "@opencode-ai/core/session/reasoning-distillation"
import { SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Hash } from "@opencode-ai/core/util/hash"
import { Token } from "@/util/token"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ModelMessage } from "ai"
import {
  bindInterleavedReasoningLineage,
  bindNativeInterleavedReasoningLineage,
  bindPersistedReasoningRefs,
  buildJudgePrompt,
  buildProposePrompt,
  buildReasoningEvidence,
  buildSlotMappings,
  emptyLifecycleState,
  extractInterleavedReasoningSlots,
  extractNativeInterleavedReasoningSlots,
  organizerFingerprintOf,
  parseCandidate,
  parseSupport,
  projectDistillationAISDK,
  reasoningHistory,
  resolveOrganizerTier,
  runJudge,
  runDistillationCycle,
  isDistillationTurn,
  runPropose,
  AuxiliaryCallError,
  type AuxiliaryCallResult,
  type AuxiliaryCaller,
  type OrganizerModel,
  type ReasoningSlotObservation,
  type ReasoningHistorySnapshot,
  type SpanResolver,
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
      sourceFingerprint: Hash.sha256(text),
      capabilityFingerprint: capabilityFingerprint(capability()),
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

type WireRequest = ReturnType<typeof wireRequest>

const baseInput = (
  request: WireRequest,
  overrides: Partial<Parameters<typeof projectDistillationAISDK<WireRequest>>[0]> = {},
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
  retentionSupport: { verdict: "supported", method: "deterministic" } as const,
  quota: exhaustedQuota,
  originalTokens: 1000,
  ...overrides,
})

describe("projectDistillationAISDK (§5.2)", () => {
  test("scheduled organization may expand short reasoning but cannot exceed the complete request capacity", () => {
    const text = "待验证"
    const request = wireRequest(text)
    const input = baseInput(request, {
      trigger: "scheduled",
      slots: [slot({ text })],
      candidate: validCandidate(text),
      originalTokens: Token.estimate(text),
      budget: { ...overBudgetInput(request.messages), contextLimit: 100_000 },
    })
    const organized = projectDistillationAISDK(input)
    expect(organized.applied).toBe(true)
    expect(organized.request.messages[0].reasoning.length).toBeGreaterThan(text.length)
    const oversized = {
      ...input.candidate,
      claims: input.candidate.claims.map((claim) => ({ ...claim, text: "结论".repeat(5000) })),
    }
    const rejected = projectDistillationAISDK({
      ...input,
      candidate: oversized,
      budget: { ...input.budget, contextLimit: 1000, outputReserve: 100 },
    })
    expect(rejected.applied).toBe(false)
    expect(rejected.request).toBe(request)
  })

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
  test("preserved source text is copied exactly or the original request is sent", () => {
    const request = wireRequest(TEXT)
    const preserved = spanFor(TEXT)
    const candidate = {
      ...validCandidate(TEXT),
      claims: [],
      preserved: [preserved],
      coverage: [{ source: preserved, action: "preserve" as const }],
    }
    const result = projectDistillationAISDK(baseInput(request, { candidate, support: [], retentionSupport: undefined }))
    expect(result.applied).toBe(false)
    expect(result.request).toBe(request)
    expect(result.plan.replacements[0]?.projection.text).toBe(TEXT)
    expect(result.skipReason).toBe("insufficient-net-savings")

    const stale = {
      ...candidate,
      preserved: [{ ...preserved, fingerprint: "wrong" }],
      coverage: [{ source: { ...preserved, fingerprint: "wrong" }, action: "preserve" as const }],
    }
    const rejected = projectDistillationAISDK(baseInput(request, { candidate: stale, support: [] }))
    expect(rejected.applied).toBe(false)
    expect(rejected.request).toBe(request)
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

describe("runDistillationCycle live lifecycle", () => {
  const candidateRaw = (text: string) => ({
    claims: [
      {
        id: "c1",
        kind: "decision",
        text: "精简结论",
        scope: "本次会话",
        sources: [{ messageID: "m1", partID: "p1", start: 0, end: text.length }],
        evidence: [{ messageID: "m1", partID: "p1", kind: "source" }],
        status: "verified",
      },
    ],
    preserved: [],
    coverage: [
      {
        source: { messageID: "m1", partID: "p1", start: 0, end: text.length },
        action: "keep",
        claimID: "c1",
      },
    ],
  })
  const cycleInput = (request: WireRequest, calls: { propose: number; judge: number }) => ({
    request,
    identity: { model: "m", runtime: "r" },
    sessionID: "s1",
    purpose: "conversation" as const,
    budget: overBudgetInput(request.messages),
    slots: [slot({ text: TEXT })],
    calls: [],
    inventoryComplete: true,
    inventoryFingerprint: "inv1",
    capability: capability(),
    records: [record()],
    organizerFingerprint: "org1",
    originalTokens: 1000,
    callPropose: async () => {
      calls.propose++
      return { output: candidateRaw(TEXT), usageTokens: 40 }
    },
    callJudge: async () => {
      calls.judge++
      return {
        output: {
          retention: { verdict: "supported" },
          support: [{ claimID: "c1", verdict: "supported", method: "judged" }],
        },
        usageTokens: 20,
      }
    },
  })

  test("scheduled preparation completes proposal and review below the capacity threshold", async () => {
    const request = wireRequest(TEXT)
    const counts = { propose: 0, judge: 0 }
    const input = {
      ...cycleInput(request, counts),
      trigger: "scheduled" as const,
      synchronous: true,
      budget: { ...overBudgetInput(request.messages), contextLimit: 100_000 },
    }
    const prepared = await runDistillationCycle(emptyLifecycleState, input)
    expect(prepared.projection.applied).toBe(true)
    expect(counts).toEqual({ propose: 1, judge: 1 })
    const replayed = await runDistillationCycle(prepared.state, { ...input, trigger: "idle" })
    expect(replayed.projection.applied).toBe(true)
    expect(counts).toEqual({ propose: 1, judge: 1 })
    const idle = await runDistillationCycle(emptyLifecycleState, { ...input, trigger: "idle" })
    expect(idle.projection.skipReason).toBe("cadence-not-due")
    expect(counts).toEqual({ propose: 1, judge: 1 })
  })

  test("scheduled transient failures do not repeat proposal in the same request", async () => {
    const request = wireRequest(TEXT)
    const counts = { propose: 0, judge: 0 }
    const result = await runDistillationCycle(emptyLifecycleState, {
      ...cycleInput(request, counts),
      trigger: "scheduled",
      synchronous: true,
      callPropose: async () => {
        counts.propose++
        throw new AuxiliaryCallError({ category: "transport" })
      },
    })
    expect(result.projection.applied).toBe(false)
    expect(counts).toEqual({ propose: 1, judge: 0 })
  })

  test("source-scoped evidence survives new user messages but detects changes in its source history", async () => {
    const sessionID = SessionID.make("ses_test")
    const user = (id: string, text: string): SessionV1.WithParts => ({
      info: {
        id: SessionV1.MessageID.make("msg_" + id),
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "test",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      },
      parts: [
        {
          id: SessionV1.PartID.make("prt_" + id),
          messageID: SessionV1.MessageID.make("msg_" + id),
          sessionID,
          type: "text",
          text,
        },
      ],
    })
    const source: SessionV1.WithParts = {
      info: {
        id: SessionV1.MessageID.make("msg_m1"),
        sessionID,
        role: "assistant",
        parentID: SessionV1.MessageID.make("msg_u1"),
        time: { created: 1 },
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test"),
        mode: "build",
        agent: "test",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: SessionV1.PartID.make("prt_p1"),
          messageID: SessionV1.MessageID.make("msg_m1"),
          sessionID,
          type: "reasoning",
          text: TEXT,
          time: { start: 1, end: 2 },
        },
      ],
    }
    const before = reasoningHistory([user("u1", "原始要求"), source])
    const after = reasoningHistory([user("u1", "原始要求"), source, user("u2", "继续")])
    const changed = reasoningHistory([user("u1", "修改要求"), source, user("u2", "继续")])
    expect(before.reasoningTurn).toBe(1)
    expect(before.scopes?.msg_m1.inventoryFingerprint).toBe(after.scopes?.msg_m1.inventoryFingerprint)
    expect(before.scopes?.msg_m1.inventoryFingerprint).not.toBe(changed.scopes?.msg_m1.inventoryFingerprint)
    const request = wireRequest(TEXT)
    const counts = { propose: 0, judge: 0 }
    const input = {
      ...cycleInput(request, counts),
      slots: [slot({ messageID: "msg_m1", partID: "prt_p1", text: TEXT })],
      callPropose: async () => {
        counts.propose++
        const candidate = candidateRaw(TEXT)
        const ref = { messageID: "msg_m1", partID: "prt_p1" }
        return {
          usageTokens: 40,
          output: {
            ...candidate,
            claims: candidate.claims.map((claim) => ({
              ...claim,
              sources: claim.sources.map((source) => ({ ...source, ...ref })),
              evidence: claim.evidence.map((evidence) => ({ ...evidence, ...ref })),
            })),
            coverage: candidate.coverage.map((entry) => ({ ...entry, source: { ...entry.source, ...ref } })),
          },
        }
      },
      trigger: "scheduled" as const,
      synchronous: true,
      inventoryFingerprint: before.inventoryFingerprint,
      evidenceByMessage: before.scopes,
    }
    const prepared = await runDistillationCycle(emptyLifecycleState, input)
    expect(prepared.projection.applied).toBe(true)
    const next = await runDistillationCycle(prepared.state, {
      ...input,
      trigger: "idle",
      inventoryFingerprint: after.inventoryFingerprint,
      evidenceByMessage: after.scopes,
    })
    expect(next.projection.applied).toBe(true)
    expect(counts).toEqual({ propose: 1, judge: 1 })
    const invalidated = await runDistillationCycle(next.state, {
      ...input,
      trigger: "idle",
      inventoryFingerprint: changed.inventoryFingerprint,
      evidenceByMessage: changed.scopes,
    })
    expect(invalidated.projection.applied).toBe(false)
    expect(invalidated.projection.request).toBe(request)
  })

  test("cached judge evidence cannot be restamped after the tool result changes", async () => {
    const request = wireRequest(TEXT)
    const counts = { propose: 0, judge: 0 }
    const input = { ...cycleInput(request, counts), calls: [call({ result: "complete" })] }
    const first = await runDistillationCycle(emptyLifecycleState, input)
    const second = await runDistillationCycle(first.state, input)
    expect(second.projection.applied).toBe(true)
    expect(second.state.cache.entries[0].certificate?.evidenceFingerprint).toBe("inv1")
    const changed = await runDistillationCycle(second.state, {
      ...input,
      calls: [call({ result: "compacted" })],
      inventoryFingerprint: "inv2",
    })
    expect(changed.projection.applied).toBe(false)
    expect(changed.projection.request).toBe(request)
    expect(changed.state.cache.entries[0].certificate?.evidenceFingerprint).toBe("inv1")
    expect(counts).toEqual({ propose: 1, judge: 1 })
  })

  test("claim approval alone does not approve omissions in the whole rendered candidate", async () => {
    const request = wireRequest(TEXT)
    const counts = { propose: 0, judge: 0 }
    const input = cycleInput(request, counts)
    const first = await runDistillationCycle(emptyLifecycleState, input)
    const judge = await runDistillationCycle(first.state, {
      ...input,
      callJudge: async (prompt) => {
        expect(prompt).toContain("最终发送文本")
        expect(prompt).toContain('"coverage"')
        expect(prompt).toContain('"sources"')
        return { output: { support: [{ claimID: "c1", verdict: "supported", method: "judged" }] }, usageTokens: 20 }
      },
    })
    expect(judge.projection.applied).toBe(false)
    expect(judge.projection.request).toBe(request)
  })

  test("uses one propose call in the first cycle and one judge call in the next before projecting", async () => {
    const request = wireRequest(TEXT)
    const calls = { propose: 0, judge: 0 }
    const first = await runDistillationCycle(emptyLifecycleState, cycleInput(request, calls))
    expect(first.attempted).toBe("propose")
    expect(first.projection.applied).toBe(false)
    expect(first.projection.request).toBe(request)
    expect(calls).toEqual({ propose: 1, judge: 0 })

    const second = await runDistillationCycle(first.state, cycleInput(request, calls))
    expect(second.attempted).toBe("judge")
    expect(second.projection.applied).toBe(true)
    expect(second.projection.request.messages[0].reasoning).toContain("精简结论")
    expect(request.messages[0].reasoning).toBe(TEXT)
    expect(calls).toEqual({ propose: 1, judge: 1 })

    const third = await runDistillationCycle(second.state, cycleInput(request, calls))
    expect(third.attempted).toBe("none")
    expect(third.projection.applied).toBe(true)
    expect(calls).toEqual({ propose: 1, judge: 1 })
  })

  test("compatibility-unproven never calls an auxiliary model", async () => {
    const request = wireRequest(TEXT)
    const calls = { propose: 0, judge: 0 }
    const result = await runDistillationCycle(emptyLifecycleState, {
      ...cycleInput(request, calls),
      records: [],
    })
    expect(result.projection.skipReason).toBe("compatibility-unproven")
    expect(result.attempted).toBe("none")
    expect(calls).toEqual({ propose: 0, judge: 0 })
  })

  test("a malformed propose result consumes quota and is not retried", async () => {
    const request = wireRequest(TEXT)
    let calls = 0
    const input = {
      ...cycleInput(request, { propose: 0, judge: 0 }),
      callPropose: async () => {
        calls++
        return { output: { malformed: true }, usageTokens: 20 }
      },
    }
    const first = await runDistillationCycle(emptyLifecycleState, input)
    const second = await runDistillationCycle(first.state, input)
    expect(first.attempted).toBe("propose")
    expect(second.attempted).toBe("none")
    expect(second.projection.skipReason).toBe("call-budget-exhausted")
    expect(calls).toBe(1)
  })

  test("persists quota before an interruptible call can return a late result", async () => {
    const request = wireRequest(TEXT)
    let finish: ((value: AuxiliaryCallResult) => void) | undefined
    let committed = emptyLifecycleState
    const pending = runDistillationCycle(emptyLifecycleState, {
      ...cycleInput(request, { propose: 0, judge: 0 }),
      callPropose: () => new Promise((resolve) => void (finish = resolve)),
      commitState: (state) => void (committed = state),
    })
    await Promise.resolve()

    expect(committed.callsBySession.s1).toBe(1)
    const retry = await runDistillationCycle(committed, cycleInput(request, { propose: 0, judge: 0 }))
    expect(retry.attempted).toBe("none")
    expect(retry.projection.skipReason).toBe("call-budget-exhausted")

    finish?.({ output: { malformed: true }, usageTokens: 20 })
    await pending
  })

  test("token reserves use the CJK-aware estimator for the built prompt", async () => {
    const request = wireRequest(TEXT)
    const prompt = buildProposePrompt({
      reasoningTexts: [TEXT],
      slotRefs: [{ messageID: "m1", partID: "p1" }],
      callSummary: [],
    })
    const expected = Token.estimateReserve(prompt) + ReasoningDistillationPolicy.tokens.maxOutputTokens
    expect(expected).toBeGreaterThan(Math.ceil(prompt.length / 4) + ReasoningDistillationPolicy.tokens.maxOutputTokens)
    const result = await runDistillationCycle(emptyLifecycleState, cycleInput(request, { propose: 0, judge: 0 }))
    expect(result.state.usageBySession.s1?.reservedTokens).toBe(expected)
  })

  test("a user abort refunds the judge attempt and never pauses paid admission", async () => {
    const request = wireRequest(TEXT)
    const first = await runDistillationCycle(emptyLifecycleState, cycleInput(request, { propose: 0, judge: 0 }))
    expect(first.attempted).toBe("propose")
    const second = await runDistillationCycle(first.state, {
      ...cycleInput(request, { propose: 0, judge: 0 }),
      callJudge: async () => {
        throw new AuxiliaryCallError({ category: "abort" })
      },
    })
    expect(second.attempted).toBe("judge")
    expect(second.state.usageBySession.s1).toMatchObject({
      paidAdmissionPaused: false,
      abortedCalls: 1,
      unknownUsageCalls: 0,
    })
    const third = await runDistillationCycle(second.state, cycleInput(request, { propose: 0, judge: 0 }))
    expect(third.attempted).toBe("judge")
  })

  test("a transport failure refunds the quota, but unknown usage keeps paid admission paused", async () => {
    const request = wireRequest(TEXT)
    const first = await runDistillationCycle(emptyLifecycleState, cycleInput(request, { propose: 0, judge: 0 }))
    expect(first.attempted).toBe("propose")
    const second = await runDistillationCycle(first.state, {
      ...cycleInput(request, { propose: 0, judge: 0 }),
      callJudge: async () => {
        throw new AuxiliaryCallError({ category: "transport" })
      },
    })
    expect(second.attempted).toBe("judge")
    expect(second.state.usageBySession.s1).toMatchObject({
      paidAdmissionPaused: true,
      abortedCalls: 0,
      unknownUsageCalls: 1,
    })
  })

  test("a parse failure with provider usage meters the tokens and does not pause", async () => {
    const request = wireRequest(TEXT)
    const first = await runDistillationCycle(emptyLifecycleState, cycleInput(request, { propose: 0, judge: 0 }))
    expect(first.attempted).toBe("propose")
    const second = await runDistillationCycle(first.state, {
      ...cycleInput(request, { propose: 0, judge: 0 }),
      callJudge: async () => {
        throw new AuxiliaryCallError({ category: "parse", usageTokens: 15 })
      },
    })
    expect(second.attempted).toBe("judge")
    expect(second.state.usageBySession.s1).toMatchObject({
      paidAdmissionPaused: false,
      actualTokens: 55,
      unknownUsageCalls: 0,
      abortedCalls: 0,
    })
  })

  test("unknown provider usage pauses later paid calls while preserving the original request", async () => {
    const request = wireRequest(TEXT)
    let calls = 0
    const first = await runDistillationCycle(emptyLifecycleState, {
      ...cycleInput(request, { propose: 0, judge: 0 }),
      callPropose: async () => {
        calls++
        return { output: candidateRaw(TEXT) }
      },
    })
    expect(first.state.usageBySession.s1).toMatchObject({
      paidAdmissionPaused: true,
      unknownUsageCalls: 1,
    })

    const second = await runDistillationCycle(first.state, cycleInput(request, { propose: 0, judge: 0 }))
    expect(second.attempted).toBe("none")
    expect(second.projection.request).toBe(request)
    expect(second.projection.skipReason).toBe("call-budget-exhausted")
    expect(calls).toBe(1)
  })

  test("processes multiple slots without starving later slots and issues at most one auxiliary call per request", async () => {
    const secondText = "第二段原始冗长思绪".repeat(20)
    const request = {
      messages: [
        { role: "assistant", reasoning: TEXT },
        { role: "assistant", reasoning: secondText },
      ],
      metadata: { mutable: "original" },
    }
    const slots = [
      slot({ text: TEXT }),
      slot({ messageID: "m2", partID: "p2", bodyPath: ["messages", 1, "reasoning"], text: secondText }),
    ]
    const calls: string[] = []
    const candidateFor = (text: string, messageID: string, partID: string) => ({
      claims: [
        {
          id: `claim-${partID}`,
          kind: "decision",
          text: `精简结论-${partID}`,
          scope: "本次会话",
          sources: [{ messageID, partID, start: 0, end: text.length }],
          evidence: [{ messageID, partID, kind: "source" }],
          status: "verified",
        },
      ],
      preserved: [],
      coverage: [
        { source: { messageID, partID, start: 0, end: text.length }, action: "keep", claimID: `claim-${partID}` },
      ],
    })
    const input = {
      ...cycleInput(request, { propose: 0, judge: 0 }),
      budget: overBudgetInput(request.messages),
      slots,
      callPropose: async (prompt: string) => {
        const selected = prompt.includes(secondText) ? [secondText, "m2", "p2"] : [TEXT, "m1", "p1"]
        calls.push(`propose-${selected[2]}`)
        return { output: candidateFor(selected[0], selected[1], selected[2]), usageTokens: 40 }
      },
      callJudge: async (prompt: string) => {
        const partID = prompt.includes(secondText) ? "p2" : "p1"
        calls.push(`judge-${partID}`)
        return {
          output: {
            retention: { verdict: "supported" },
            support: [{ claimID: `claim-${partID}`, verdict: "supported", method: "judged" }],
          },
          usageTokens: 20,
        }
      },
    }

    let state = emptyLifecycleState
    let current = request
    for (let index = 0; index < 4; index++) {
      const cycle = await runDistillationCycle(state, input)
      state = cycle.state
      current = cycle.projection.request
    }

    expect(calls).toEqual(["propose-p1", "judge-p1", "propose-p2", "judge-p2"])
    expect(current.messages[0].reasoning).toContain("精简结论-p1")
    expect(current.messages[1].reasoning).toContain("精简结论-p2")
    expect(request.messages[0].reasoning).toBe(TEXT)
    expect(request.messages[1].reasoning).toBe(secondText)
  })

  test("enforces the total per-session auxiliary-call ceiling", async () => {
    const request = wireRequest(TEXT)
    let calls = 0
    const result = await runDistillationCycle(
      {
        ...emptyLifecycleState,
        callsBySession: { s1: ReasoningDistillationPolicy.calls.maxCallsPerSession },
      },
      {
        ...cycleInput(request, { propose: 0, judge: 0 }),
        callPropose: async () => (calls++, { output: candidateRaw(TEXT), usageTokens: 20 }),
      },
    )
    expect(result.attempted).toBe("none")
    expect(result.projection.skipReason).toBe("call-budget-exhausted")
    expect(calls).toBe(0)
  })
})

const model = (modelID: string, overrides: Partial<OrganizerModel> = {}): OrganizerModel => ({
  providerID: "local-proxy-compatible",
  modelID,
  ...overrides,
})

describe("resolveOrganizerTier (§5.6)", () => {
  test("picks the small model first when available", () => {
    const resolution = resolveOrganizerTier(
      { small: model("deepseek"), agent: model("agent"), primary: model("primary") },
      1000,
    )
    expect(resolution?.tier).toBe("small")
    expect(resolution?.fallback).toEqual([])
    expect(resolution?.organizerFingerprint).toBe(organizerFingerprintOf(model("deepseek")))
  })

  test("falls back to agent when small is unavailable, recording the reason", () => {
    const resolution = resolveOrganizerTier(
      { small: undefined, agent: model("agent"), primary: model("primary") },
      1000,
    )
    expect(resolution?.tier).toBe("agent")
    expect(resolution?.fallback).toEqual([{ tier: "small", reason: "unavailable" }])
  })

  test("dedups an identical model and skips one below the context requirement", () => {
    const same = model("deepseek", { contextLimit: 500 })
    const resolution = resolveOrganizerTier(
      { small: same, agent: same, primary: model("primary", { contextLimit: 8000 }) },
      1000,
    )
    expect(resolution?.tier).toBe("primary")
    expect(resolution?.fallback).toEqual([
      { tier: "small", reason: "insufficient-context" },
      { tier: "agent", reason: "duplicate" },
    ])
  })

  test("returns undefined when no tier is usable", () => {
    expect(resolveOrganizerTier({ small: undefined, agent: undefined, primary: undefined }, 1000)).toBeUndefined()
  })

  test("organizerFingerprint is stable and variant-sensitive", () => {
    expect(organizerFingerprintOf(model("deepseek"))).toBe(organizerFingerprintOf(model("deepseek")))
    expect(organizerFingerprintOf(model("deepseek"))).not.toBe(
      organizerFingerprintOf(model("deepseek", { variant: "v2" })),
    )
  })
})

const resolver: SpanResolver = (ref) =>
  ref.end <= ref.start
    ? undefined
    : { ...ref, fingerprint: Hash.sha256(`${ref.messageID}:${ref.partID}:${ref.start}:${ref.end}`) }

const distillKey = (): DistillationKey => ({
  sessionID: "s1",
  messageID: "m1",
  partIDs: ["p1"],
  sourceFingerprint: "sf1",
  capabilityFingerprint: "cap1",
  organizerFingerprint: "org1",
  policyVersion: POLICY,
})

const validRaw = {
  claims: [
    {
      id: "c1",
      kind: "decision",
      text: "精简结论",
      scope: "本次会话",
      sources: [{ messageID: "m1", partID: "p1", start: 0, end: 5 }],
      evidence: [{ messageID: "m1", partID: "p1", kind: "source" }],
      status: "verified",
    },
  ],
  preserved: [],
  coverage: [{ source: { messageID: "m1", partID: "p1", start: 0, end: 5 }, action: "keep", claimID: "c1" }],
}

describe("parseCandidate (§5.5.3 untrusted output)", () => {
  test("parses a well-formed candidate and binds span fingerprints via the resolver", () => {
    const candidate = parseCandidate(validRaw, distillKey(), resolver)
    expect(candidate?.claims[0].sources[0].fingerprint).toBe(Hash.sha256("m1:p1:0:5"))
    expect(candidate?.coverage[0]).toMatchObject({ action: "keep", claimID: "c1" })
    expect(candidate?.key).toEqual(distillKey())
  })
  test("rejects an unknown claim kind or status", () => {
    const badKind = { ...validRaw, claims: [{ ...validRaw.claims[0], kind: "noise" }] }
    const badStatus = { ...validRaw, claims: [{ ...validRaw.claims[0], status: "maybe" }] }
    expect(parseCandidate(badKind, distillKey(), resolver)).toBeUndefined()
    expect(parseCandidate(badStatus, distillKey(), resolver)).toBeUndefined()
  })
  test("rejects a span the resolver cannot bind", () => {
    const bad = {
      ...validRaw,
      claims: [{ ...validRaw.claims[0], sources: [{ messageID: "m1", partID: "p1", start: 5, end: 5 }] }],
    }
    expect(parseCandidate(bad, distillKey(), resolver)).toBeUndefined()
  })
  test("rejects non-record output or a missing array section", () => {
    expect(parseCandidate(null, distillKey(), resolver)).toBeUndefined()
    expect(parseCandidate({ claims: [], preserved: [] }, distillKey(), resolver)).toBeUndefined()
  })
  test("a drop entry requires a non-empty reason", () => {
    const dropNoReason = {
      ...validRaw,
      coverage: [{ source: { messageID: "m1", partID: "p1", start: 0, end: 5 }, action: "drop" }],
    }
    expect(parseCandidate(dropNoReason, distillKey(), resolver)).toBeUndefined()
  })
})

describe("parseSupport", () => {
  test("parses supported/unknown verdicts", () => {
    const support = parseSupport({
      support: [
        { claimID: "c1", verdict: "supported", method: "judged" },
        { claimID: "c2", verdict: "unknown", reasonCode: "truncated" },
      ],
    })
    expect(support).toEqual([
      { claimID: "c1", result: { verdict: "supported", method: "judged" } },
      { claimID: "c2", result: { verdict: "unknown", reasonCode: "truncated" } },
    ])
  })
  test("a model cannot label its own judgment as deterministic evidence", () => {
    expect(parseSupport({ support: [{ claimID: "c1", verdict: "supported", method: "deterministic" }] })).toEqual([
      { claimID: "c1", result: { verdict: "supported", method: "judged" } },
    ])
  })
  test("rejects a verdict missing its method or reasonCode", () => {
    expect(parseSupport({ support: [{ claimID: "c1", verdict: "supported" }] })).toBeUndefined()
    expect(parseSupport({ support: [{ claimID: "c1", verdict: "unknown" }] })).toBeUndefined()
  })
  test("rejects malformed top-level output", () => {
    expect(parseSupport([])).toBeUndefined()
    expect(parseSupport({ support: "nope" })).toBeUndefined()
  })
})

describe("extractInterleavedReasoningSlots (W1, §2)", () => {
  const field = "reasoning_content"

  test("extracts the openaiCompatible interleaved field from an assistant message", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [], providerOptions: { openaiCompatible: { reasoning_content: "思考过程" } } },
    ]
    const slots = extractInterleavedReasoningSlots(messages, field)
    expect(slots).toHaveLength(1)
    expect(slots[0]).toMatchObject({
      bodyPath: ["messages", 1, "providerOptions", "openaiCompatible", "reasoning_content"],
      text: "思考过程",
      shape: "interleaved-field",
      signed: false,
      encrypted: false,
      settled: false,
      structureRewritable: false,
    })
  })

  test("skips non-assistant messages and empty or missing fields", () => {
    const messages = [
      { role: "user", providerOptions: { openaiCompatible: { reasoning_content: "x" } } },
      { role: "assistant", providerOptions: { openaiCompatible: { reasoning_content: "" } } },
      { role: "assistant", content: [{ type: "text", text: "no reasoning field" }] },
    ]
    expect(extractInterleavedReasoningSlots(messages, field)).toHaveLength(0)
  })

  test("extracts multiple assistant slots with index-correct body paths", () => {
    const messages = [
      { role: "assistant", providerOptions: { openaiCompatible: { reasoning_content: "a" } } },
      { role: "user", content: [] },
      { role: "assistant", providerOptions: { openaiCompatible: { reasoning_content: "b" } } },
    ]
    const slots = extractInterleavedReasoningSlots(messages, field)
    expect(slots.map((s) => s.bodyPath)).toEqual([
      ["messages", 0, "providerOptions", "openaiCompatible", "reasoning_content"],
      ["messages", 2, "providerOptions", "openaiCompatible", "reasoning_content"],
    ])
  })

  test("honors a custom base path into the projection request", () => {
    const messages = [{ role: "assistant", providerOptions: { openaiCompatible: { reasoning_content: "z" } } }]
    const slots = extractInterleavedReasoningSlots(messages, field, ["prompt", "messages"])
    expect(slots[0].bodyPath).toEqual([
      "prompt",
      "messages",
      0,
      "providerOptions",
      "openaiCompatible",
      "reasoning_content",
    ])
  })
})

describe("prompt builders (§5.4.1 / §5.5.3)", () => {
  test("source coordinates preserve UTF-16 boundaries and all whitespace", () => {
    const text = "甲😀\n\n乙\r\n末"
    const prompt = buildProposePrompt({
      reasoningTexts: [text],
      slotRefs: [{ messageID: "m", partID: "p" }],
      callSummary: [],
    })
    expect(prompt).toContain(`UTF-16 length=${text.length}`)
    expect(prompt).toContain(
      JSON.stringify([
        { start: 0, end: 4, text: "甲😀\n" },
        { start: 4, end: 5, text: "\n" },
        { start: 5, end: 8, text: "乙\r\n" },
        { start: 8, end: 9, text: "末" },
      ]),
    )
  })

  test("propose prompt frames input as untrusted, requires Chinese output with verbatim identifiers, and embeds R/E", () => {
    const prompt = buildProposePrompt({
      reasoningTexts: ["原始思绪甲", "原始思绪乙"],
      slotRefs: [
        { messageID: "msg_01a0def4b881TZa1qIqRrBA6u2", partID: "part_0" },
        { messageID: "msg_01a0def4b886ucYYKbl0Nfta4E", partID: "part_1" },
      ],
      callSummary: ["bash c1 completed"],
    })
    expect(prompt).toContain("不可信数据")
    expect(prompt).toContain("一律用中文")
    expect(prompt).toContain("逐字保留")
    expect(prompt).toContain("原始思绪甲")
    expect(prompt).toContain("原始思绪乙")
    expect(prompt).toContain("bash c1 completed")
    expect(prompt).toContain("coverage")
  })

  test("propose prompt exposes the real span identities so models can cite resolvable messageID/partID values", () => {
    const prompt = buildProposePrompt({
      reasoningTexts: ["原始思绪甲"],
      slotRefs: [{ messageID: "msg_01a0def4b881TZa1qIqRrBA6u2", partID: "part_0" }],
      callSummary: [],
    })
    expect(prompt).toContain("(messageID=msg_01a0def4b881TZa1qIqRrBA6u2, partID=part_0)")
    expect(prompt).toContain("逐字使用各 slot 标注的值")
  })

  test("propose prompt renders an empty call inventory explicitly", () => {
    expect(buildProposePrompt({ reasoningTexts: ["x"], slotRefs: [], callSummary: [] })).toContain("（无工具调用）")
  })

  test("judge prompt is independent, lists G1-G4, and embeds the candidate claims", () => {
    const prompt = buildJudgePrompt({
      reasoningTexts: ["原始思绪"],
      slotRefs: [{ messageID: "msg_01a0def4b881TZa1qIqRrBA6u2", partID: "part_0" }],
      candidateClaims: [{ id: "c1", kind: "decision", text: "采用方案A", scope: "本次会话", status: "verified" }],
      callSummary: [],
    })
    expect(prompt).toContain("独立保真审查器")
    expect(prompt).toContain("不看整理器的自评")
    expect(prompt).toContain("G1")
    expect(prompt).toContain("G4")
    expect(prompt).toContain("c1")
    expect(prompt).toContain("采用方案A")
  })
})

describe("runPropose / runJudge orchestration (§5.5.3)", () => {
  test("runPropose parses a well-formed model output into a Candidate", async () => {
    const callModel: AuxiliaryCaller = async () => ({ output: validRaw, usageTokens: 20 })
    const candidate = await runPropose({ key: distillKey(), prompt: "p", resolveSpan: resolver, callModel })
    expect(candidate?.claims[0].id).toBe("c1")
  })

  test("runPropose returns undefined on malformed output", async () => {
    const callModel: AuxiliaryCaller = async () => ({ output: { garbage: true }, usageTokens: 20 })
    expect(await runPropose({ key: distillKey(), prompt: "p", resolveSpan: resolver, callModel })).toBeUndefined()
  })

  test("runJudge parses support verdicts", async () => {
    const callModel: AuxiliaryCaller = async () => ({
      output: {
        retention: { verdict: "supported" },
        support: [{ claimID: "c1", verdict: "supported", method: "judged" }],
      },
      usageTokens: 20,
    })
    expect(await runJudge({ prompt: "p", callModel })).toEqual([
      { claimID: "c1", result: { verdict: "supported", method: "judged" } },
    ])
  })

  test("runJudge returns undefined on malformed output", async () => {
    const callModel: AuxiliaryCaller = async () => ({ output: "not json", usageTokens: 20 })
    expect(await runJudge({ prompt: "p", callModel })).toBeUndefined()
  })
})

describe("bindPersistedReasoningRefs (§5.8 stable cache keys)", () => {
  const wireSlot = (text: string, index: number): ReasoningSlotObservation => ({
    messageID: `messages.${index}`,
    partID: "reasoning_content",
    bodyPath: ["messages", index, "providerOptions", "openaiCompatible", "reasoning_content"],
    text,
    shape: "interleaved-field",
    signed: false,
    encrypted: false,
    settled: true,
    structureRewritable: true,
  })

  test("rebinds a wire slot only with explicit wire position and exact text, preserving bodyPath", () => {
    const slots = [wireSlot("思考甲", 0)]
    const bound = bindPersistedReasoningRefs(slots, [
      { messageID: "msg_abc", partID: "part_1", text: "思考甲", wireMessageIndex: 0 },
    ])
    expect(bound[0].messageID).toBe("msg_abc")
    expect(bound[0].partID).toBe("part_1")
    expect(bound[0].bodyPath).toEqual(slots[0].bodyPath)
  })

  test("an unmatched slot keeps its wire-position id", () => {
    const slots = [wireSlot("无匹配", 2)]
    const bound = bindPersistedReasoningRefs(slots, [{ messageID: "msg_x", partID: "part_y", text: "其他" }])
    expect(bound[0].messageID).toBe("messages.2")
  })

  test("duplicate persisted text at the same wire position stays unbound", () => {
    const slots = [wireSlot("重复", 0)]
    const persisted = [
      { messageID: "msg_first", partID: "p1", text: "重复", wireMessageIndex: 0 },
      { messageID: "msg_second", partID: "p2", text: "重复", wireMessageIndex: 0 },
    ]
    expect(bindPersistedReasoningRefs(slots, persisted)[0].messageID).toBe("messages.0")
  })

  test("identical text at different wire positions binds to the corresponding persisted part", () => {
    const slots = [wireSlot("重复", 0), wireSlot("重复", 2)]
    const persisted = [
      { messageID: "msg_first", partID: "p1", text: "重复", wireMessageIndex: 0 },
      { messageID: "msg_second", partID: "p2", text: "重复", wireMessageIndex: 2 },
    ]
    expect(bindPersistedReasoningRefs(slots, persisted).map((item) => item.messageID)).toEqual([
      "msg_first",
      "msg_second",
    ])
  })

  test("text match without explicit wire position cannot bind identity", () => {
    const slots = [wireSlot("重复", 0)]
    expect(
      bindPersistedReasoningRefs(slots, [{ messageID: "msg_signed", partID: "p1", text: "重复" }])[0].messageID,
    ).toBe("messages.0")
  })
})

describe("persisted history to final W1 lineage", () => {
  const source = (texts: readonly string[]): ModelMessage => ({
    role: "assistant",
    content: texts.map((text) => ({ type: "reasoning" as const, text })),
  })
  const transformed = (text: string): ModelMessage => ({
    role: "assistant",
    content: [],
    providerOptions: { openaiCompatible: { reasoning_content: text } },
  })
  const history = (groups: ReasoningHistorySnapshot["groups"]): ReasoningHistorySnapshot => ({
    groups,
    calls: [],
    inventoryComplete: true,
    inventoryFingerprint: "inventory",
  })
  const part = (messageID: string, partID: string, text: string) => ({
    messageID,
    partID,
    text,
    signed: false,
    encrypted: false,
    settled: true,
  })

  test("binds duplicate text by chronological source order and exact final wire position", () => {
    const snapshot = history([
      { messageID: "m1", parts: [part("m1", "p1", "重复")] },
      { messageID: "m2", parts: [part("m2", "p2", "重复")] },
    ])
    const lineage = bindInterleavedReasoningLineage(
      [source(["重复"]), { role: "user", content: "next" }, source(["重复"])],
      [transformed("重复"), { role: "user", content: "next" }, transformed("重复")],
      "reasoning_content",
      snapshot,
    )
    expect(lineage.map((item) => [item.wireMessageIndex, item.parts[0].messageID, item.parts[0].partID])).toEqual([
      [0, "m1", "p1"],
      [2, "m2", "p2"],
    ])
  })

  test("preserves multi-part lineage so the extractor can protect the joined W1 slot", () => {
    const snapshot = history([{ messageID: "m1", parts: [part("m1", "p1", "甲"), part("m1", "p2", "乙")] }])
    const lineage = bindInterleavedReasoningLineage(
      [source(["甲", "乙"])],
      [transformed("甲乙")],
      "reasoning_content",
      snapshot,
    )
    expect(lineage[0].parts.map((item) => item.partID)).toEqual(["p1", "p2"])
    const slots = extractInterleavedReasoningSlots([transformed("甲乙")], "reasoning_content", ["messages"], lineage)
    expect(slots[0].structureRewritable).toBe(false)
    expect(slots[0].settled).toBe(false)
  })

  test("conversion drift produces no lineage instead of guessing by text", () => {
    const snapshot = history([{ messageID: "m1", parts: [part("m1", "p1", "原文")] }])
    expect(
      bindInterleavedReasoningLineage([source(["原文"])], [transformed("被变更")], "reasoning_content", snapshot),
    ).toEqual([])
  })

  test("re-indexes exact lineage after Native lowering removes system messages", () => {
    const snapshot = history([{ messageID: "m1", parts: [part("m1", "p1", "原文")] }])
    const sourceMessages: ModelMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "question" },
      source(["原文"]),
    ]
    const transformedMessages: ModelMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "question" },
      transformed("原文"),
    ]
    const lineage = bindNativeInterleavedReasoningLineage(
      sourceMessages,
      transformedMessages,
      "reasoning_content",
      snapshot,
    )
    expect(lineage.map((item) => item.wireMessageIndex)).toEqual([1])
    const slots = extractNativeInterleavedReasoningSlots(
      [
        { role: "user", content: [] },
        {
          role: "assistant",
          content: [],
          native: { openaiCompatible: { reasoning_content: "原文" } },
        },
      ],
      "reasoning_content",
      lineage,
    )
    expect(slots[0]).toMatchObject({
      messageID: "m1",
      partID: "p1",
      bodyPath: ["messages", 1, "native", "openaiCompatible", "reasoning_content"],
      structureRewritable: true,
      settled: true,
    })
  })

  test("history records protection metadata, settlement, and incomplete tool inventory without payload leakage", () => {
    const messages = [
      {
        info: { id: "m1", role: "assistant" },
        parts: [
          {
            id: "r1",
            messageID: "m1",
            sessionID: "s1",
            type: "reasoning",
            text: "秘密原文",
            metadata: { anthropic: { signature: "sig" }, openai: { reasoningEncryptedContent: "cipher" } },
            time: { start: 1 },
          },
          {
            id: "t1",
            messageID: "m1",
            sessionID: "s1",
            type: "tool",
            callID: "c1",
            tool: "read",
            state: { status: "running", input: { filePath: "/secret" }, time: { start: 1 } },
          },
        ],
      },
    ] as unknown as SessionV1.WithParts[]
    const snapshot = reasoningHistory(messages)
    expect(snapshot.groups[0].parts[0]).toMatchObject({
      messageID: "m1",
      partID: "r1",
      signed: true,
      encrypted: true,
      settled: false,
    })
    expect(snapshot.inventoryComplete).toBe(false)
    expect(snapshot.calls[0]).toMatchObject({ status: "running", result: "missing", provenance: "unavailable" })
    expect(snapshot.inventoryFingerprint).not.toContain("秘密原文")
    expect(snapshot.inventoryFingerprint).not.toContain("/secret")
  })
})

describe("review regressions: conservation and source binding", () => {
  test.each(["drop", "preserve", "merge"] as const)("never clears an entire slot through %s coverage", (action) => {
    const request = wireRequest(TEXT),
      source = spanFor(TEXT)
    const coverage =
      action === "drop"
        ? { source, action, reason: "noise" }
        : action === "merge"
          ? { source, action, witness: source }
          : { source, action }
    const candidate = { ...validCandidate(TEXT), claims: [], preserved: [], coverage: [coverage] }
    const result = projectDistillationAISDK(baseInput(request, { candidate, support: [], retentionSupport: undefined }))
    expect(result.applied).toBe(false)
    expect(result.request).toBe(request)
  })
  test("renders uncertainty and superseded decisions in the actual outbound text", () => {
    const text = "最初采用 A，随后改为 B；部署成功只是未验证假设。".repeat(50)
    const request = wireRequest(text),
      original = validCandidate(text)
    const candidate: Candidate = {
      ...original,
      claims: [
        { ...original.claims[0], id: "old", text: "采用 A" },
        { ...original.claims[0], id: "new", text: "采用 B", supersedes: "old" },
        { ...original.claims[0], id: "assumption", text: "部署成功", kind: "assumption", status: "unverified" },
      ],
      coverage: [{ source: spanFor(text), action: "keep", claimID: "new" }],
    }
    const result = projectDistillationAISDK(
      baseInput(request, {
        slots: [slot({ text })],
        candidate,
        support: candidate.claims.map((c) => ({
          claimID: c.id,
          result: { verdict: "supported", method: "deterministic" },
        })),
      }),
    )
    expect(result.applied).toBe(true)
    expect(result.request.messages[0].reasoning).toContain("未验证")
    expect(result.request.messages[0].reasoning).toContain("已被 new 取代")
    expect(result.request.messages[0].reasoning).toContain("假设")
  })
  test("accepts source subranges and rejects tampered fingerprints", () => {
    const text = "生产变更需要授权。".repeat(50) + "保持测试记录。",
      end = text.length - "保持测试记录。".length
    const request = wireRequest(text),
      original = validCandidate(text)
    const first = { ...spanFor(text), end, fingerprint: Hash.sha256(text.slice(0, end)) }
    const rest = { ...spanFor(text), start: end, fingerprint: Hash.sha256(text.slice(end)) }
    const candidate: Candidate = {
      ...original,
      claims: [{ ...original.claims[0], sources: [first], text: "生产变更需要授权。" }],
      preserved: [rest],
      coverage: [
        { source: first, action: "keep", claimID: "c1" },
        { source: rest, action: "preserve" },
      ],
    }
    const input = baseInput(request, { slots: [slot({ text })], candidate })
    expect(projectDistillationAISDK(input).applied).toBe(true)
    for (const start of [end - 1, end + 1]) {
      const tail = { ...rest, start, fingerprint: Hash.sha256(text.slice(start)) }
      const invalid = {
        ...candidate,
        preserved: [tail],
        coverage: [
          { source: first, action: "keep" as const, claimID: "c1" },
          { source: tail, action: "preserve" as const },
        ],
      }
      expect(projectDistillationAISDK({ ...input, candidate: invalid }).applied).toBe(false)
    }
    expect(
      projectDistillationAISDK({
        ...input,
        candidate: {
          ...candidate,
          claims: [{ ...candidate.claims[0], sources: [{ ...first, fingerprint: "wrong" }] }],
        },
      }).applied,
    ).toBe(false)
  })
  test("rejects a tool result relabeled as an instruction with a different call ID", () => {
    const request = wireRequest(TEXT),
      original = validCandidate(TEXT)
    const candidate: Candidate = {
      ...original,
      claims: [
        {
          ...original.claims[0],
          evidence: [{ messageID: "m0", partID: "tool", callID: "wrong", kind: "instruction" }],
        },
      ],
    }
    const result = projectDistillationAISDK(
      baseInput(request, { candidate, calls: [call({ messageID: "m0", partID: "tool", callID: "real" })] }),
    )
    expect(result.applied).toBe(false)
    expect(result.skipReason).toBe("evidence-unresolved")
  })
})

test("reasoning preparation cadence is first turn then every three user turns", () => {
  expect(Array.from({ length: 11 }, (_, turn) => turn).filter(isDistillationTurn)).toEqual([1, 4, 7, 10])
  expect(isDistillationTurn(NaN)).toBe(false)
  expect(isDistillationTurn(1.5)).toBe(false)
})
