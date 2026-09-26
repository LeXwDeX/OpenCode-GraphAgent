import { describe, expect } from "bun:test"
import {
  LLM,
  LLMEvent,
  LLMResponse,
  Model,
  PreparedRequest,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ConfigReasoningDistillation } from "@opencode-ai/core/config/reasoning-distillation"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import * as CoreReasoningDistillation from "@opencode-ai/core/session/runner/reasoning-distillation"
import { toLLMMessagesWithBindings } from "@opencode-ai/core/session/runner/to-llm-message"
import { Hash } from "@opencode-ai/core/util/hash"
import { DateTime, Deferred, Effect, Fiber, Stream } from "effect"
import { it } from "../lib/effect"

const model = Model.make({
  id: "distillation-model",
  provider: "distillation-provider",
  route: OpenAIChat.route.with({ limits: { context: 1_000, output: 100 } }),
})
const modelRef = {
  id: ModelV2.ID.make(String(model.id)),
  providerID: ProviderV2.ID.make(String(model.provider)),
}
const now = DateTime.makeUnsafe(1)
const reasoningText = `需要保留这个决定：使用安全路径。${"重复背景。".repeat(10_000)}`

const history = (providerMetadata?: Record<string, Record<string, unknown>>): SessionMessage.Assistant => ({
  id: SessionMessage.ID.make("msg_reasoning"),
  type: "assistant",
  agent: "build",
  model: modelRef,
  time: { created: now, completed: now },
  content: [
    {
      type: "reasoning",
      id: "reasoning-1",
      text: reasoningText,
      providerMetadata,
    },
  ],
})

const prepare = (request: LLMRequest) =>
  request.model.route.body.from(request).pipe(
    Effect.map(
      (body) =>
        new PreparedRequest({
          id: "request",
          route: request.model.route.id,
          protocol: request.model.route.protocol,
          model: request.model,
          body,
        }),
    ),
  )

const response = (text: string, usageTokens: number | null = 20) => {
  const value = LLMResponse.fromEvents([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text }),
    LLMEvent.textEnd({ id: "text" }),
    LLMEvent.stepFinish({
      index: 0,
      reason: "stop",
      ...(usageTokens === null
        ? {}
        : { usage: { inputTokens: usageTokens - 5, outputTokens: 5, totalTokens: usageTokens } }),
    }),
    LLMEvent.finish({ reason: "stop" }),
  ])
  if (!value) throw new Error("expected complete response")
  return value
}

const compatibility = new ConfigReasoningDistillation.Compatibility({
  runtime: "core-runner",
  protocol: "openai-chat",
  providerModelVariant: "distillation-provider/distillation-model/default",
  endpointIdentity: Hash.sha256(model.route.id),
  adapterVersion: CoreReasoningDistillation.adapterVersion,
  optionsFingerprint: Hash.sha256("{}"),
  transportVerified: true,
  upstreamVerified: true,
})

const candidate = JSON.stringify({
  claims: [
    {
      id: "claim-1",
      kind: "decision",
      text: "决定使用安全路径。",
      scope: "当前实现",
      sources: [{ messageID: "msg_reasoning", partID: "reasoning-1", start: 0, end: reasoningText.length }],
      evidence: [{ messageID: "msg_reasoning", partID: "reasoning-1", kind: "source" }],
      status: "unverified",
    },
  ],
  preserved: [],
  coverage: [
    {
      source: { messageID: "msg_reasoning", partID: "reasoning-1", start: 0, end: reasoningText.length },
      action: "keep",
      claimID: "claim-1",
    },
  ],
})
const support = JSON.stringify({ support: [{ claimID: "claim-1", verdict: "supported", method: "judged" }] })

describe("Core runner reasoning distillation adapter", () => {
  it.effect("keeps exact reasoning paths after empty canonical parts are removed", () =>
    Effect.sync(() => {
      const source = history()
      const conversion = toLLMMessagesWithBindings(
        [
          {
            ...source,
            content: [{ type: "text", id: "empty", text: "" }, ...source.content],
          },
        ],
        model,
      )
      expect(conversion.reasoningBindings[0]?.bodyPath).toEqual(["messages", 0, "content", 0, "text"])
      expect(conversion.messages[0]?.content[0]?.type).toBe("reasoning")
    }),
  )

  it.effect("proposes on the first request and judges/projects the exact canonical reasoning slot on the second", () =>
    Effect.gen(function* () {
      const generated: LLMRequest[] = []
      const outputs = [candidate, support]
      const client: LLMClientShape = {
        prepare: prepare as unknown as LLMClientShape["prepare"],
        stream: () => Stream.empty,
        generate: (request) =>
          Effect.sync(() => {
            generated.push(request)
            return response(outputs.shift() ?? "{}")
          }),
      }
      const adapter = CoreReasoningDistillation.make(client)
      const source = history()
      const conversion = toLLMMessagesWithBindings([source], model)
      const request = LLM.request({ model, messages: conversion.messages })
      const prepared = yield* prepare(request)
      const input = {
        sessionID: "ses_distillation",
        request,
        prepared,
        sourceMessages: [source],
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [compatibility] }),
      }

      const first = yield* adapter.distill(input)
      expect(first.attempted).toBe("propose")
      expect(first.applied).toBe(false)
      expect(first.request).toBe(request)

      const second = yield* adapter.distill(input)
      expect(second.attempted).toBe("judge")
      expect(second.applied).toBe(true)
      expect(second.request).not.toBe(request)
      expect(JSON.stringify(second.request.messages)).toContain("决定使用安全路径")
      expect(JSON.stringify(second.request.messages)).not.toContain("重复背景")
      expect(JSON.stringify(request.messages)).toContain("重复背景")
      expect(JSON.stringify(request.messages)).not.toContain("决定使用安全路径")
      expect(source.content[0]).toMatchObject({ type: "reasoning", text: reasoningText })
      expect(generated).toHaveLength(2)
      expect(generated.every((item) => item.metadata?.purpose === "auxiliary")).toBe(true)

      const replay = yield* adapter.distill(input)
      expect({ attempted: replay.attempted, applied: replay.applied, skipReason: replay.skipReason }).toEqual({
        attempted: "none",
        applied: true,
        skipReason: undefined,
      })
      expect(JSON.stringify(replay.request.messages)).toContain("决定使用安全路径")
      expect(generated).toHaveLength(2)
    }),
  )

  it.effect("does not call an auxiliary model without compatibility proof or for signed reasoning", () =>
    Effect.gen(function* () {
      let calls = 0
      const client: LLMClientShape = {
        prepare: prepare as unknown as LLMClientShape["prepare"],
        stream: () => Stream.empty,
        generate: () => Effect.sync(() => (calls++, response(candidate))),
      }
      for (const [source, config] of [
        [history(), new ConfigReasoningDistillation.Info({})],
        [
          history({ openai: { signature: "opaque" } }),
          new ConfigReasoningDistillation.Info({ compatibility: [compatibility] }),
        ],
      ] as const) {
        const conversion = toLLMMessagesWithBindings([source], model)
        const request = LLM.request({ model, messages: conversion.messages })
        const result = yield* CoreReasoningDistillation.make(client).distill({
          sessionID: `ses_protected_${calls}`,
          request,
          prepared: yield* prepare(request),
          sourceMessages: [source],
          bindings: conversion.reasoningBindings,
          config,
        })
        expect(result.applied).toBe(false)
        expect(result.request).toBe(request)
      }
      expect(calls).toBe(0)
    }),
  )

  it.effect("pauses later paid calls when the provider omits usage", () =>
    Effect.gen(function* () {
      let calls = 0
      const client: LLMClientShape = {
        prepare: prepare as unknown as LLMClientShape["prepare"],
        stream: () => Stream.empty,
        generate: () => Effect.sync(() => (calls++, response(candidate, null))),
      }
      const adapter = CoreReasoningDistillation.make(client)
      const source = history()
      const conversion = toLLMMessagesWithBindings([source], model)
      const request = LLM.request({ model, messages: conversion.messages })
      const input = {
        sessionID: "ses_unmetered",
        request,
        prepared: yield* prepare(request),
        sourceMessages: [source],
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [compatibility] }),
      }

      const first = yield* adapter.distill(input)
      const second = yield* adapter.distill(input)
      expect(first.attempted).toBe("propose")
      expect(second.attempted).toBe("none")
      expect(second.skipReason).toBe("call-budget-exhausted")
      expect(second.request).toBe(request)
      expect(calls).toBe(1)
    }),
  )

  it.effect("pauses later paid calls when actual usage exceeds the reservation", () =>
    Effect.gen(function* () {
      let calls = 0
      const client: LLMClientShape = {
        prepare: prepare as unknown as LLMClientShape["prepare"],
        stream: () => Stream.empty,
        generate: () => Effect.sync(() => (calls++, response(candidate, 999_999))),
      }
      const adapter = CoreReasoningDistillation.make(client)
      const source = history()
      const conversion = toLLMMessagesWithBindings([source], model)
      const request = LLM.request({ model, messages: conversion.messages })
      const input = {
        sessionID: "ses_overage",
        request,
        prepared: yield* prepare(request),
        sourceMessages: [source],
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [compatibility] }),
      }

      const first = yield* adapter.distill(input)
      const second = yield* adapter.distill(input)
      expect(first.usage).toMatchObject({ paidAdmissionPaused: true, actualTokens: 999_999 })
      expect(second.skipReason).toBe("call-budget-exhausted")
      expect(second.request).toBe(request)
      expect(calls).toBe(1)
    }),
  )

  it.effect("per-session reservation ceiling never blocks a different session on the same runner", () =>
    Effect.gen(function* () {
      let calls = 0
      const client: LLMClientShape = {
        prepare: prepare as unknown as LLMClientShape["prepare"],
        stream: () => Stream.empty,
        generate: () => Effect.sync(() => (calls++, response(candidate, 999_999))),
      }
      const adapter = CoreReasoningDistillation.make(client)
      const source = history()
      const conversion = toLLMMessagesWithBindings([source], model)
      const request = LLM.request({ model, messages: conversion.messages })
      const prepared = yield* prepare(request)
      const makeInput = (sessionID: string) => ({
        sessionID,
        request,
        prepared,
        sourceMessages: [source],
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [compatibility] }),
      })

      const paused = yield* adapter.distill(makeInput("ses_paused_a"))
      const other = yield* adapter.distill(makeInput("ses_fresh_b"))
      expect(paused.usage).toMatchObject({ paidAdmissionPaused: true })
      expect(other.attempted).toBe("propose")
      expect(other.usage).toMatchObject({ paidAdmissionPaused: true, reservedTokens: paused.usage?.reservedTokens })
      expect(calls).toBe(2)
    }),
  )

  it.effect("consumes quota before cancellation and cannot adopt a late result", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      let calls = 0
      const client: LLMClientShape = {
        prepare: prepare as unknown as LLMClientShape["prepare"],
        stream: () => Stream.empty,
        generate: () =>
          Effect.sync(() => calls++).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
          ),
      }
      const adapter = CoreReasoningDistillation.make(client)
      const source = history()
      const conversion = toLLMMessagesWithBindings([source], model)
      const request = LLM.request({ model, messages: conversion.messages })
      const input = {
        sessionID: "ses_cancelled",
        request,
        prepared: yield* prepare(request),
        sourceMessages: [source],
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [compatibility] }),
      }

      const fiber = yield* adapter.distill(input).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const retry = yield* adapter.distill(input)
      expect(retry.attempted).toBe("none")
      expect(retry.skipReason).toBe("call-budget-exhausted")
      expect(retry.request).toBe(request)
      expect(calls).toBe(1)
    }),
  )

  it.effect("advances multiple exact slots without issuing more than one auxiliary call per request", () =>
    Effect.gen(function* () {
      const secondText = `第二个决定：保留回滚路径。${"第二段背景。".repeat(10_000)}`
      const source = {
        ...history(),
        content: [
          ...history().content,
          { type: "reasoning" as const, id: "reasoning-2", text: secondText },
        ],
      }
      const candidateFor = (partID: string, text: string, claimID: string, claimText: string) =>
        JSON.stringify({
          claims: [
            {
              id: claimID,
              kind: "decision",
              text: claimText,
              scope: "当前实现",
              sources: [{ messageID: "msg_reasoning", partID, start: 0, end: text.length }],
              evidence: [{ messageID: "msg_reasoning", partID, kind: "source" }],
              status: "unverified",
            },
          ],
          preserved: [],
          coverage: [
            {
              source: { messageID: "msg_reasoning", partID, start: 0, end: text.length },
              action: "keep",
              claimID,
            },
          ],
        })
      const generated: LLMRequest[] = []
      const outputs = [
        candidateFor("reasoning-1", reasoningText, "claim-1", "决定使用安全路径。"),
        support,
        candidateFor("reasoning-2", secondText, "claim-2", "决定保留回滚路径。"),
        JSON.stringify({ support: [{ claimID: "claim-2", verdict: "supported", method: "judged" }] }),
      ]
      const client: LLMClientShape = {
        prepare: prepare as unknown as LLMClientShape["prepare"],
        stream: () => Stream.empty,
        generate: (request) =>
          Effect.sync(() => {
            generated.push(request)
            return response(outputs.shift() ?? "{}")
          }),
      }
      const adapter = CoreReasoningDistillation.make(client)
      const conversion = toLLMMessagesWithBindings([source], model)
      const request = LLM.request({ model, messages: conversion.messages })
      const input = {
        sessionID: "ses_multi",
        request,
        prepared: yield* prepare(request),
        sourceMessages: [source],
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [compatibility] }),
      }

      const snapshots: Array<[boolean, boolean]> = []
      let result = yield* adapter.distill(input)
      snapshots.push([JSON.stringify(result.request.messages).includes("决定使用安全路径"), false])
      result = yield* adapter.distill(input)
      snapshots.push([JSON.stringify(result.request.messages).includes("决定使用安全路径"), false])
      result = yield* adapter.distill(input)
      snapshots.push([JSON.stringify(result.request.messages).includes("决定使用安全路径"), false])
      result = yield* adapter.distill(input)

      const projected = JSON.stringify(result.request.messages)
      snapshots.push([
        projected.includes("决定使用安全路径"),
        projected.includes("决定保留回滚路径"),
      ])
      expect(snapshots).toEqual([
        [false, false],
        [true, false],
        [true, false],
        [true, true],
      ])
      expect(generated).toHaveLength(4)
    }),
  )
})
