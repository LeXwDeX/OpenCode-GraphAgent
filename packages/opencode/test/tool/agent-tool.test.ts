import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { DagAgentMessages } from "@/dag/agent-messages"
import { MessageID, SessionID } from "@/session/schema"
import { AgentTool, Parameters } from "@/tool/agent"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ProviderTransform } from "@/provider/transform"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Layer.mock(Agent.Service, {
      get: () => Effect.succeed({ name: "build", mode: "all", permission: [], options: {} }),
    }),
    Layer.mock(Truncate.Service, {
      output: (content: string) => Effect.succeed({ content, truncated: false }),
    }),
  ),
)

function context(): Tool.Context {
  return {
    sessionID: SessionID.make("ses_agent_actual"),
    messageID: MessageID.make("msg_agent_actual"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    ask: () => Effect.void,
    metadata: () => Effect.void,
  }
}

const send = {
  action: "send" as const,
  recipient: "node" as const,
  workflow_id: "wf_owned",
  node_id: "worker",
  attempt_id: "attempt_original",
  idempotency_key: "request_1",
  content: "Check the new finding",
}

describe("agent tool contract", () => {
  test("has a plain object schema on Qwen, GLM and DeepSeek transports", () => {
    for (const modelID of ["qwen3.5-plus", "glm-5.3", "deepseek-v4-pro"]) {
      const modalities = { text: true, audio: false, image: false, video: false, pdf: false }
      const model: Provider.Model = {
        id: ModelV2.ID.make(modelID),
        providerID: ProviderV2.ID.make("local-proxy"),
        api: { id: modelID, npm: "@ai-sdk/openai-compatible", url: "http://localhost" },
        name: modelID,
        release_date: "2026-01-01",
        status: "active",
        options: {},
        headers: {},
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: modalities,
          output: modalities,
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 32768, output: 4096 },
      }
      const schema = ProviderTransform.schema(model, ToolJsonSchema.fromSchema(Parameters))
      expect(schema.type).toBe("object")
      expect(schema.anyOf).toBeUndefined()
      expect(schema.oneOf).toBeUndefined()
      expect(schema.allOf).toBeUndefined()
      expect(schema.properties).toHaveProperty("params")
      const wire = JSON.stringify(schema)
      expect(wire).not.toContain('"session_id"')
      expect(wire).not.toContain('"project_id"')
      expect(wire).not.toContain('"sender"')
    }
  })

  test("requires an exact attempt and retry key when sending to a node", () => {
    const decode = Schema.decodeUnknownResult(Parameters, { onExcessProperty: "error" })
    expect(Result.isSuccess(decode({ params: send }))).toBe(true)
    expect(Result.isSuccess(decode({ params: { ...send, attempt_id: undefined } }))).toBe(false)
    expect(Result.isSuccess(decode({ params: { ...send, idempotency_key: undefined } }))).toBe(false)
    expect(Result.isSuccess(decode({ params: { ...send, sessionID: "ses_impersonated" } }))).toBe(false)
    expect(Result.isSuccess(decode({ params: { ...send, recipient: "parent" } }))).toBe(false)
  })

  test("bounds receive waits, batches and message payloads without truncation", () => {
    const decode = Schema.decodeUnknownResult(Parameters)
    expect(Result.isSuccess(decode({ params: { action: "receive" } }))).toBe(true)
    for (const params of [
      { action: "receive", wait_ms: 30_001 },
      { action: "receive", limit: 51 },
      { action: "receive", after_sequence: -1 },
      { ...send, content: "x".repeat(16_385) },
      { ...send, content: "" },
    ])
      expect(Result.isSuccess(decode({ params }))).toBe(false)
  })

  it.effect("passes trusted session and exact destination through to durable acceptance", () =>
    Effect.gen(function* () {
      let received: Parameters<DagAgentMessages.Interface["send"]>[0] | undefined
      const service = Layer.mock(DagAgentMessages.Service, {
        send: (input) =>
          Effect.sync(() => {
            received = input
            return { state: "queued", message_id: "message_stable" }
          }),
      })
      const tool = yield* AgentTool.pipe(Effect.provide(service))
      const definition = yield* tool.init()
      const result = yield* definition.execute({ params: send }, context())
      expect(received?.sessionID).toBe("ses_agent_actual")
      expect(received?.attempt_id).toBe("attempt_original")
      expect(JSON.parse(result.output).state).toBe("queued")
      expect(result.output).not.toContain("delivered")
    }),
  )

  it.effect("receive forwards cancellation and returns records without delivery acknowledgement", () =>
    Effect.gen(function* () {
      const ctx = context()
      let signal: AbortSignal | undefined
      const service = Layer.mock(DagAgentMessages.Service, {
        receive: (input) =>
          Effect.sync(() => {
            signal = input.signal
            return { messages: [{ message_id: "message_stable", state: "queued" }], cursor: 1 }
          }),
      })
      const tool = yield* AgentTool.pipe(Effect.provide(service))
      const definition = yield* tool.init()
      const result = yield* definition.execute({ params: { action: "receive", wait_ms: 10 } }, ctx)
      expect(signal).toBe(ctx.abort)
      expect(JSON.parse(result.output).messages[0].state).toBe("queued")
    }),
  )
})
