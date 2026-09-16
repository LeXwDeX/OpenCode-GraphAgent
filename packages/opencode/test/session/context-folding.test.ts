import { describe, expect, test } from "bun:test"
import type { FoldRef } from "@opencode-ai/core/session/context-folding"
import { jsonSchema, tool, type ModelMessage } from "ai"
import { ContextFolding, type Snapshot } from "@/session/context-folding"
import { LLMNative } from "@/session/llm/native-request"
import { ProviderTransform } from "@/provider/transform"
import { ProviderTest } from "../fake/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const source: FoldRef = { messageID: "msg_source", partID: "prt_source", callID: "call:source" }
const witness: FoldRef = { messageID: "msg_witness", partID: "prt_witness", callID: "call:witness" }
const body = "same complete tool output\n".repeat(600)
const tools = {
  read: tool({
    description: "Read a file",
    inputSchema: jsonSchema({
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
      additionalProperties: false,
    }),
  }),
}

function model(apiID = "gpt-5.2", providerID = "openai") {
  return ProviderTest.model({
    id: ModelV2.ID.make(apiID),
    providerID: ProviderV2.ID.make(providerID),
    api: { id: apiID, url: "https://example.com", npm: "@ai-sdk/openai" },
    limit: { context: 4_000, input: 4_000, output: 512 },
  })
}

function snapshot(sourceRef = source, witnessRef = witness): Snapshot {
  return {
    duplicatePlan: {
      replacements: [{ source: sourceRef, witness: witnessRef }],
      protectedStepIDs: ["recent"],
      exclusions: [],
      skipReason: undefined,
    },
    references: [
      { ref: sourceRef, toolName: "read", complete: true },
      { ref: witnessRef, toolName: "read", complete: true },
    ],
  }
}

function messages(sourceID = source.callID, witnessID = witness.callID, sharedOutput?: object): ModelMessage[] {
  const output = sharedOutput ?? { type: "text", value: body }
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: sourceID,
          toolName: "read",
          input: { filePath: "/tmp/a.txt" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: sourceID,
          toolName: "read",
          output: output as { type: "text"; value: string },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: witnessID,
          toolName: "read",
          input: { filePath: "/tmp/a.txt" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: witnessID,
          toolName: "read",
          output: output as { type: "text"; value: string },
        },
      ],
    },
  ]
}

function aiProjection(input: {
  model?: ReturnType<typeof model>
  messages?: ModelMessage[]
  preparedMessages?: ModelMessage[]
  snapshot?: Snapshot
  purpose?: "conversation" | "compaction" | "auxiliary" | "unknown"
}) {
  const selected = input.model ?? model()
  const transformed =
    input.preparedMessages ?? ProviderTransform.message(input.messages ?? messages(), selected, {})
  return ContextFolding.projectAISDK({
    model: selected,
    purpose: input.purpose ?? "conversation",
    snapshot: input.snapshot ?? snapshot(),
    messages: transformed,
    tools,
    maxOutputTokens: 512,
    params: { maxOutputTokens: 512 },
    system: { kind: "messages" },
  })
}

function outputValue(projected: { messages: ModelMessage[] }, index: number) {
  const message = projected.messages[index]
  if (!message || !Array.isArray(message.content)) return undefined
  const part = message.content[0]
  if (!part || part.type !== "tool-result") return undefined
  return part.output.type === "text" ? part.output.value : undefined
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}

describe("session.context-folding OpenCode wire adapters", () => {
  test("projects the AI SDK final provider-visible request without mutating stored messages", () => {
    const stored = messages()
    const before = structuredClone(stored)
    const outbound = deepFreeze(ProviderTransform.message(structuredClone(stored), model(), {}))
    const projected = aiProjection({ preparedMessages: outbound })

    expect(projected.applied).toBe(true)
    expect(outputValue(projected.request, 1)).toContain("Duplicate tool output folded")
    expect(outputValue(projected.request, 1)).toContain(witness.callID)
    expect(outputValue(projected.request, 3)).toBe(body)
    expect(stored).toEqual(before)
    expect(outbound).toEqual(ProviderTransform.message(structuredClone(stored), model(), {}))
  })

  test("duplicates shared host aliases into an independent wire tree before projection", () => {
    const shared = { type: "text", value: body }
    const original = messages(source.callID, witness.callID, shared)
    const projected = aiProjection({ messages: original })

    expect(projected.applied).toBe(true)
    expect(outputValue(projected.request, 1)).not.toBe(body)
    expect(outputValue(projected.request, 3)).toBe(body)
    expect(shared.value).toBe(body)
  })

  test("supports non-colliding Claude and Mistral IDs through the shared scrub helper", () => {
    const claude = model("claude-4-sonnet")
    const claudeResult = aiProjection({ model: claude })
    expect(claudeResult.applied).toBe(true)
    expect(outputValue(claudeResult.request, 1)).toContain(ProviderTransform.toolCallID(witness.callID, claude))

    const mistralSource = { ...source, callID: "sourceABC:1" }
    const mistralWitness = { ...witness, callID: "witnessXY:2" }
    const mistral = model("mistral-large", "mistral")
    const mistralResult = aiProjection({
      model: mistral,
      snapshot: snapshot(mistralSource, mistralWitness),
      messages: messages(mistralSource.callID, mistralWitness.callID),
    })
    expect(mistralResult.applied).toBe(true)
    expect(outputValue(mistralResult.request, 1)).toContain(
      ProviderTransform.toolCallID(mistralWitness.callID, mistral),
    )
  })

  test("fails closed when Claude or Mistral scrubbing collides", () => {
    const claudeSource = { ...source, callID: "same:id" }
    const claudeWitness = { ...witness, callID: "same?id" }
    const claude = model("claude-4-sonnet")
    const claudeResult = aiProjection({
      model: claude,
      snapshot: snapshot(claudeSource, claudeWitness),
      messages: messages(claudeSource.callID, claudeWitness.callID),
    })
    expect(claudeResult.applied).toBe(false)
    expect(claudeResult.plan.skipReason).toBe("mapping-mismatch")

    const mistralSource = { ...source, callID: "abcdefghi-source" }
    const mistralWitness = { ...witness, callID: "abcdefghi-witness" }
    const mistral = model("mistral-large", "mistral")
    const mistralResult = aiProjection({
      model: mistral,
      snapshot: snapshot(mistralSource, mistralWitness),
      messages: messages(mistralSource.callID, mistralWitness.callID),
    })
    expect(mistralResult.applied).toBe(false)
    expect(mistralResult.plan.skipReason).toBe("mapping-mismatch")
  })

  test("projects canonical Native messages before executable definitions are added", () => {
    const selected = model()
    const canonical = LLMNative.request({
      model: selected,
      apiKey: "test-key",
      messages: ProviderTransform.message(messages(), selected, {}),
      tools,
      maxOutputTokens: 512,
    })
    const projected = ContextFolding.projectNative({
      model: selected,
      purpose: "conversation",
      snapshot: snapshot(),
      request: canonical,
      tools,
      maxOutputTokens: 512,
      params: { maxOutputTokens: 512 },
      system: { kind: "messages" },
    })

    expect(projected.applied).toBe(true)
    expect(JSON.stringify(projected.request.messages)).toContain("Duplicate tool output folded")
    expect(JSON.stringify(canonical.messages)).not.toContain("Duplicate tool output folded")
  })

  test("skips compaction, auxiliary and unknown purposes", () => {
    for (const purpose of ["compaction", "auxiliary", "unknown"] as const) {
      const projected = aiProjection({ purpose })
      expect(projected.applied).toBe(false)
      expect(projected.plan.skipReason).toBe("no-eligible-duplicates")
    }
  })

  test("fails closed for an incomplete result mapping", () => {
    const complete = snapshot()
    const incomplete: ContextFolding.Snapshot = {
      ...complete,
      references: complete.references.map((reference, index) =>
        index === 0 ? { ...reference, complete: false } : reference,
      ),
    }
    const projected = aiProjection({ snapshot: incomplete })
    expect(projected.applied).toBe(false)
    expect(projected.plan.skipReason).toBe("mapping-mismatch")
  })
})
