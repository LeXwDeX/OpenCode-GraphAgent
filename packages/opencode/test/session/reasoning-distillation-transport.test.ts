import { describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import {
  ReasoningDistillationPolicy,
  capabilityFingerprint,
  type Candidate,
} from "@opencode-ai/core/session/reasoning-distillation"
import { Hash } from "@opencode-ai/core/util/hash"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { streamText, type ModelMessage } from "ai"
import { Effect } from "effect"
import { ProviderTransform } from "../../src/provider/transform"
import {
  extractInterleavedReasoningSlots,
  projectDistillationAISDK,
  type InterleavedSlotLineage,
  type ReasoningSlotObservation,
} from "../../src/session/reasoning-distillation"
import { ProviderTest } from "../fake/provider"
import { TestLLMServer } from "../lib/llm-server"

// This is controlled local transport evidence for W1. It deliberately does not authorize a real upstream tuple.
const FIELD = "reasoning_content"
const ORIGINAL = "推理原文需要保留的信息。".repeat(120)
const CANARY = "AUDIT_ONLY_CANARY_9d450f54"

function compatibleModel() {
  const model = ProviderTest.model({
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    api: { id: "test-model", url: "http://localhost", npm: "@ai-sdk/openai-compatible" },
    limit: { context: 4000, input: 4000, output: 512 },
  })
  return {
    ...model,
    capabilities: { ...model.capabilities, interleaved: { field: FIELD as "reasoning_content" } },
  }
}

function sourceMessages(): ModelMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "继续工具调用" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: ORIGINAL },
        { type: "text", text: "我将读取文件" },
        { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { filePath: "/tmp/example" } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call-1", toolName: "read", output: { type: "text", value: "结果" } },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "读取完毕" }] },
  ]
}

function preparedRequest() {
  const stored = sourceMessages()
  const messages = ProviderTransform.message(structuredClone(stored), compatibleModel(), {})
  const lineage: InterleavedSlotLineage[] = [
    {
      wireMessageIndex: 1,
      parts: [
        {
          messageID: "persisted-message-1",
          partID: "persisted-reasoning-1",
          text: ORIGINAL,
          signed: false,
          encrypted: false,
          settled: true,
        },
      ],
    },
  ]
  return {
    stored,
    lineage,
    request: { messages, metadata: { trace: "unchanged" } },
  }
}

function candidateFor(slot: ReasoningSlotObservation): Candidate {
  const span = {
    messageID: slot.messageID,
    partID: slot.partID,
    start: 0,
    end: slot.text.length,
    fingerprint: Hash.sha256(slot.text),
  }
  return {
    key: {
      sessionID: "transport-test",
      messageID: slot.messageID,
      partIDs: [slot.partID],
      sourceFingerprint: span.fingerprint,
      capabilityFingerprint: capabilityFingerprint({
        runtime: "opencode-ai-sdk",
        protocol: "openai-compatible",
        providerModelVariant: "test/test-model",
        endpointIdentity: "controlled-local-test-server",
        adapterVersion: "test-v1",
        optionsFingerprint: "fixture",
      }),
      organizerFingerprint: "fixture",
      policyVersion: ReasoningDistillationPolicy.version,
    },
    fingerprint: "candidate-1",
    claims: [
      {
        id: "decision-1",
        kind: "decision",
        text: "继续读取后的处理",
        scope: "本次会话",
        sources: [span],
        evidence: [{ messageID: slot.messageID, partID: slot.partID, kind: "source" }],
        status: "verified",
      },
    ],
    preserved: [],
    coverage: [{ source: span, action: "keep", claimID: "decision-1" }],
  }
}

function projection(
  request: ReturnType<typeof preparedRequest>["request"],
  authorized: boolean,
  lineage: readonly InterleavedSlotLineage[],
) {
  const slots = extractInterleavedReasoningSlots(request.messages, FIELD, ["messages"], lineage)
  const capability = {
    runtime: "opencode-ai-sdk",
    protocol: "openai-compatible",
    providerModelVariant: "test/test-model",
    endpointIdentity: "controlled-local-test-server",
    adapterVersion: "test-v1",
    optionsFingerprint: "fixture",
  }
  return projectDistillationAISDK({
    request,
    identity: { model: "test-model", runtime: "ai-sdk" },
    purpose: "conversation",
    budget: {
      contextLimit: 40,
      inputLimit: { kind: "absent" },
      outputReserve: 5,
      system: { kind: "none" },
      messages: request.messages,
      tools: [],
      protocolOverheadTokens: 0,
      media: "none",
    },
    slots,
    calls: [],
    inventoryComplete: true,
    inventoryFingerprint: "complete-fixture",
    capability,
    records: authorized ? [{ ...capability, transportVerified: true, upstreamVerified: true }] : [],
    candidate: candidateFor(slots[0]),
    support: [{ claimID: "decision-1", result: { verdict: "supported", method: "deterministic" } }],
    targets: [
      {
        id: CANARY,
        claimID: "decision-1",
        modality: "reported",
        requiredBy: [{ messageID: slots[0].messageID, partID: slots[0].partID }],
        toolName: "bash",
        selector: { kind: "at-least-one" },
        expectation: "succeeded",
        scope: { messageIDs: [slots[0].messageID], stepIDs: [], settled: true },
      },
    ],
    quota: { proposeUsed: true, judgeUsed: true },
    originalTokens: 1000,
  })
}

async function captureUpstream(messages: ModelMessage[]) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* TestLLMServer
      yield* Effect.promise(async () => {
        const provider = createOpenAICompatible({ name: "local-test", baseURL: server.url, apiKey: "local-test-key" })
        await streamText({ model: provider.chatModel("test-model"), messages }).text
      })
      const inputs = yield* server.inputs
      return inputs[0]
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}

function wireMessages(wire: unknown): Record<string, unknown>[] {
  if (typeof wire !== "object" || wire === null || !("messages" in wire)) throw new Error("missing wire messages")
  if (
    !Array.isArray(wire.messages) ||
    !wire.messages.every(
      (message: unknown) => typeof message === "object" && message !== null && !Array.isArray(message),
    )
  ) {
    throw new Error("invalid wire messages")
  }
  return wire.messages
}

describe("reasoning distillation W1 controlled transport (§2.1)", () => {
  test("the final transformed request sends only the projected eligible slot", async () => {
    const { stored, lineage, request } = preparedRequest()
    const originalRequest = structuredClone(request)
    const slots = extractInterleavedReasoningSlots(request.messages, FIELD, ["messages"], lineage)
    expect(slots).toHaveLength(1)
    expect(slots[0]?.text).toBe(ORIGINAL)
    expect(slots[0]?.bodyPath).toEqual(["messages", 1, "providerOptions", "openaiCompatible", FIELD])

    const projected = projection(request, true, lineage)
    expect(projected.applied).toBe(true)
    expect(projected.plan.audit).toContainEqual(
      expect.objectContaining({
        subject: "source-agent",
        findings: [expect.objectContaining({ targetID: CANARY, kind: "simulated_execution" })],
      }),
    )
    expect(request).toEqual(originalRequest)
    expect(projected.request.metadata).toEqual(originalRequest.metadata)
    expect(stored).toEqual(sourceMessages())
    const originalWire = await captureUpstream(request.messages)
    const projectedWire = await captureUpstream(projected.request.messages)
    const originalMessages = wireMessages(originalWire)
    const projectedMessages = wireMessages(projectedWire)
    expect(originalMessages[1]?.reasoning_content).toBe(ORIGINAL)
    expect(projectedMessages[1]?.reasoning_content).toContain("继续读取后的处理")
    expect(projectedMessages[1]?.reasoning_content).not.toBe(ORIGINAL)
    expect(
      projectedMessages.map((message, index) => (index === 1 ? { ...message, reasoning_content: ORIGINAL } : message)),
    ).toEqual(originalMessages)
    expect(JSON.stringify(projectedWire)).not.toContain(CANARY)
  })

  test("without upstream evidence the actual SDK payload preserves the original, including tool continuation", async () => {
    const { request, lineage } = preparedRequest()
    const projected = projection(request, false, lineage)
    expect(projected.applied).toBe(false)
    expect(projected.skipReason).toBe("compatibility-unproven")
    expect(projected.request).toBe(request)
    const wire = await captureUpstream(projected.request.messages)
    const messages = wireMessages(wire)
    expect(messages[1]?.reasoning_content).toBe(ORIGINAL)
    expect(messages[1]?.tool_calls).toEqual([
      { id: "call-1", type: "function", function: { name: "read", arguments: '{"filePath":"/tmp/example"}' } },
    ])
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "call-1", content: "结果" })
    expect(messages[3]).toMatchObject({ role: "assistant", reasoning_content: "", content: "读取完毕" })
  })

  test("an empty interleaved field stays present and is not a rewrite candidate", async () => {
    const { request, lineage } = preparedRequest()
    const observed = extractInterleavedReasoningSlots(request.messages, FIELD, ["messages"], lineage)
    expect(observed).toHaveLength(1)
    const wire = await captureUpstream(request.messages)
    const messages = wireMessages(wire)
    expect(Object.hasOwn(messages[3], FIELD)).toBe(true)
    expect(messages[3]?.reasoning_content).toBe("")
    expect(messages[0]).toMatchObject({ role: "user", content: "继续工具调用" })
  })

  test("signed or unsettled observations remain protected even with a matching dual-evidence fixture", async () => {
    const { request, lineage } = preparedRequest()
    const signedLineage = [{ ...lineage[0], parts: [{ ...lineage[0].parts[0], signed: true }] }]
    const unsettledLineage = [{ ...lineage[0], parts: [{ ...lineage[0].parts[0], settled: false }] }]
    const signed = projection(request, true, signedLineage)
    const unsettled = projection(request, true, unsettledLineage)
    expect(signed.applied).toBe(false)
    expect(unsettled.applied).toBe(false)
    expect(signed.request).toBe(request)
    expect(unsettled.request).toBe(request)
    expect(signed.plan.skipReason).toBe("no-rewritable-slot")
    expect(unsettled.plan.skipReason).toBe("no-rewritable-slot")
    const wire = await captureUpstream(signed.request.messages)
    const messages = wireMessages(wire)
    expect(messages[1]?.reasoning_content).toBe(ORIGINAL)
  })

  test("missing, conflicting, or incomplete source lineage never licenses a W1 rewrite", () => {
    const { request, lineage } = preparedRequest()
    const cases: InterleavedSlotLineage[][] = [
      [],
      [...lineage, ...lineage],
      [{ ...lineage[0], parts: [{ ...lineage[0].parts[0], text: "different source" }] }],
    ]
    for (const source of cases) {
      const slot = extractInterleavedReasoningSlots(request.messages, FIELD, ["messages"], source)[0]
      expect(slot?.settled).toBe(false)
      const result = projection(request, true, source)
      expect(result.applied).toBe(false)
      expect(result.request).toBe(request)
    }
  })

  test("multiple source reasoning parts are joined on wire but protected until part-level evidence exists", () => {
    const stored = sourceMessages()
    const message = stored[1]
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) throw new Error("invalid fixture")
    message.content = [
      { type: "reasoning", text: ORIGINAL.slice(0, ORIGINAL.length / 2) },
      { type: "reasoning", text: ORIGINAL.slice(ORIGINAL.length / 2) },
      ...message.content.filter((part) => part.type !== "reasoning"),
    ]
    const messages = ProviderTransform.message(structuredClone(stored), compatibleModel(), {})
    const lineage: InterleavedSlotLineage[] = [
      {
        wireMessageIndex: 1,
        parts: [
          {
            messageID: "persisted-message-1",
            partID: "reasoning-a",
            text: ORIGINAL.slice(0, ORIGINAL.length / 2),
            signed: false,
            encrypted: false,
            settled: true,
          },
          {
            messageID: "persisted-message-1",
            partID: "reasoning-b",
            text: ORIGINAL.slice(ORIGINAL.length / 2),
            signed: false,
            encrypted: false,
            settled: true,
          },
        ],
      },
    ]
    const slots = extractInterleavedReasoningSlots(messages, FIELD, ["messages"], lineage)
    expect(slots[0]?.text).toBe(ORIGINAL)
    expect(slots[0]?.settled).toBe(false)
  })

  test("a signed source part must not become an apparently unsigned W1 slot after model switching", () => {
    const stored: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: ORIGINAL, providerOptions: { anthropic: { signature: "opaque-signature" } } },
        ],
      },
    ]
    const transformed = ProviderTransform.message(structuredClone(stored), compatibleModel(), {})
    const lineage: InterleavedSlotLineage[] = [
      {
        wireMessageIndex: 0,
        parts: [
          {
            messageID: "signed-message",
            partID: "signed-part",
            text: ORIGINAL,
            signed: true,
            encrypted: false,
            settled: true,
          },
        ],
      },
    ]
    const slots = extractInterleavedReasoningSlots(transformed, FIELD, ["messages"], lineage)
    expect(slots).toHaveLength(1)
    expect(slots[0]?.signed).toBe(true)
    expect(slots[0]?.messageID).toBe("signed-message")
    expect(extractInterleavedReasoningSlots(transformed, FIELD)[0]?.settled).toBe(false)
  })
})
