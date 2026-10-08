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
import { RequestExecutor } from "@opencode-ai/llm/route"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ConfigReasoningDistillation } from "@opencode-ai/core/config/reasoning-distillation"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import * as CoreReasoningDistillation from "@opencode-ai/core/session/runner/reasoning-distillation"
import { COVERAGE_CONTRACT, DENOISING_CONTRACT } from "@opencode-ai/core/session/reasoning-distillation"
import { toLLMMessagesWithBindings } from "@opencode-ai/core/session/runner/to-llm-message"
import { Hash } from "@opencode-ai/core/util/hash"
import { DateTime, Deferred, Duration, Effect, Fiber, Stream } from "effect"
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
const reasoningText = `需要保留这个决定：使用安全路径。${"重复背景。".repeat(4_000)}`

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

const mockPrepare = prepare as unknown as LLMClientShape["prepare"]

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
      sources: ["R0.0"],
      evidence: [{ messageID: "msg_reasoning", partID: "reasoning-1", kind: "source" }],
      status: "unverified",
    },
  ],
  preserved: [],
  coverage: [
    {
      source: "R0.0",
      action: "keep",
      claimID: "claim-1",
    },
  ],
})
const support = JSON.stringify({
  retention: { verdict: "supported" },
  support: [{ claimID: "claim-1", verdict: "supported", method: "judged" }],
})

describe("Core runner reasoning distillation adapter", () => {
  it.live("cancels the underlying canonical model call and keeps its quota spent", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      let calls = 0
      let stopped = false
      const client: LLMClientShape = {
        prepare: mockPrepare,
        stream: () => Stream.empty,
        generate: () =>
          Effect.promise((signal) => {
            calls++
            return new Promise<LLMResponse>((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  stopped = true
                  resolve(response("late"))
                },
                { once: true },
              )
              queueMicrotask(() => Effect.runSync(Deferred.succeed(started, undefined)))
            })
          }),
      }
      const adapter = CoreReasoningDistillation.make(client)
      const source = history()
      const conversion = toLLMMessagesWithBindings([source], model)
      const request = LLM.request({ model, messages: conversion.messages })
      const input = {
        target: "canonical" as const,
        sessionID: "ses_canonical_cancelled",
        request,
        auxiliaryModel: model,
        prepared: yield* prepare(request),
        sourceMessages: [source],
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [] }),
      }
      const fiber = yield* adapter.distill(input).pipe(Effect.forkChild)
      yield* Deferred.await(started).pipe(
        Effect.timeout(Duration.seconds(2)),
        Effect.mapError(() => Error("start timeout")),
      )
      yield* Fiber.interrupt(fiber).pipe(
        Effect.timeout(Duration.seconds(2)),
        Effect.mapError(() => Error("interrupt timeout")),
      )
      expect(stopped).toBe(true)
      expect(calls).toBe(1)
    }),
  )

  it.effect("organizes two canonical slots in one model call", () =>
    Effect.gen(function* () {
      let calls = 0
      const client: LLMClientShape = {
        prepare: mockPrepare,
        stream: () => Stream.empty,
        generate: () =>
          Effect.sync(() => {
            calls++
            return response(
              JSON.stringify({
                items: [
                  { slot: 0, text: "决定使用安全路径。" },
                  { slot: 1, text: "权限不足，尚未完成。" },
                ],
              }),
            )
          }),
      }
      const source = {
        ...history(),
        content: [
          ...history().content,
          {
            type: "reasoning" as const,
            id: "reasoning-2",
            text: "运行迁移时权限不足，无法写入目标目录。更换目录后仍失败，任务未完成，需要用户授权后再继续。",
          },
        ],
      }
      const conversion = toLLMMessagesWithBindings([source], model)
      const request = LLM.request({ model, messages: conversion.messages })
      const result = yield* CoreReasoningDistillation.make(client).distill({
        target: "canonical",
        sessionID: "ses_multi_canonical",
        request,
        auxiliaryModel: model,
        prepared: yield* prepare(request),
        sourceMessages: [source],
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [] }),
      })
      expect(calls).toBe(1)
      expect(result.applied).toBe(true)
      expect(result.replacements).toHaveLength(2)
      expect(result.request).toBe(request)
    }),
  )

  it.effect("distills a persisted canonical part without wire compatibility proof or changing the request", () =>
    Effect.gen(function* () {
      const outputs = ["决定使用安全路径。"]
      const generated: LLMRequest[] = []
      const client: LLMClientShape = {
        prepare: mockPrepare,
        stream: () => Stream.empty,
        generate: (request) =>
          Effect.gen(function* () {
            expect(yield* RequestExecutor.MaxRetries).toBe(0)
            generated.push(request)
            return response(outputs.shift() ?? "{}")
          }),
      }
      const adapter = CoreReasoningDistillation.make(client)
      const source = history()
      const conversion = toLLMMessagesWithBindings([source], model)
      const request = LLM.request({ model, messages: conversion.messages })
      const smallModel = Model.make({
        id: "small-distillation",
        provider: "distillation-provider",
        route: model.route.with({ http: { body: { reasoning_effort: "high", harmless: "keep" } } }),
      })
      const input = {
        target: "canonical" as const,
        sessionID: "ses_canonical",
        request,
        auxiliaryModel: smallModel,
        prepared: yield* prepare(request),
        sourceMessages: [source],
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [] }),
      }
      const result = yield* adapter.distill(input)
      expect(result.attempted).toBe("propose")
      expect(result.applied).toBe(true)
      expect(result.request).toBe(request)
      expect(result.replacements).toEqual([
        {
          messageID: source.id,
          partID: "reasoning-1",
          before: reasoningText,
          after: expect.stringContaining("决定使用安全路径"),
        },
      ])
      expect(generated).toHaveLength(1)
      expect(String(generated[0]?.model.id)).toBe("small-distillation")
      expect(JSON.stringify((yield* prepare(generated[0]!)).body)).toContain('"reasoning_effort":"low"')
      const effective = LLM.updateRequest(generated[0]!, {
        http: { body: { ...smallModel.route.defaults.http?.body, ...generated[0]!.http?.body } },
      })
      const transport = yield* smallModel.route.prepareTransport((yield* prepare(effective)).body, effective)
      const wire = JSON.parse(JSON.parse(JSON.stringify(transport.request.body)).body) as Record<string, unknown>
      expect(wire.reasoning_effort).toBe("low")
      expect(wire.harmless).toBe("keep")
      expect(source.content[0]).toMatchObject({ text: reasoningText })
    }),
  )

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
        prepare: mockPrepare,
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
      expect(JSON.stringify(generated[0].messages)).toContain(source.id)
      expect(JSON.stringify(generated[0].messages)).toContain(source.content[0].id)
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

  it.effect("offers only preceding tool evidence to the organizer", () =>
    Effect.gen(function* () {
      let prompt = ""
      const client: LLMClientShape = {
        prepare: () => Effect.die("proposal must not prepare an altered request"),
        stream: () => Stream.empty,
        generate: (request) =>
          Effect.sync(() => {
            prompt = JSON.stringify(request.messages)
            return response(candidate)
          }),
      }
      const tool = (id: string): SessionMessage.AssistantTool => ({
        type: "tool",
        id,
        name: "read",
        state: { status: "completed", input: {}, structured: {}, content: [] },
        time: { created: now, ran: now, completed: now },
      })
      const original = history()
      const source: SessionMessage.Assistant = {
        ...original,
        content: [tool("z-prior-tool"), ...original.content, tool("a-future-tool")],
      }
      const conversion = toLLMMessagesWithBindings([source], model)
      const request = LLM.request({ model, messages: conversion.messages })
      const adapter = CoreReasoningDistillation.make(client)
      const result = yield* adapter.distill({
        sessionID: "ses_temporal_evidence",
        request,
        prepared: yield* prepare(request),
        sourceMessages: [source],
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [compatibility] }),
      })
      expect(result.attempted).toBe("propose")
      expect(prompt).toContain("z-prior-tool")
      expect(prompt).toContain(JSON.stringify(COVERAGE_CONTRACT).slice(1, -1))
      expect(prompt).toContain(JSON.stringify(DENOISING_CONTRACT).slice(1, -1))
      expect(prompt).not.toContain("a-future-tool")
    }),
  )

  it.effect("prepares on the first user turn and preserves replay after later messages", () =>
    Effect.gen(function* () {
      const roomyModel = Model.make({
        id: model.id,
        provider: model.provider,
        route: OpenAIChat.route.with({ limits: { context: 100_000, output: 4096 } }),
      })
      const user: SessionMessage.User = {
        id: SessionMessage.ID.make("msg_user"),
        type: "user",
        text: "分析方案",
        time: { created: now },
      }
      const sourceMessages = [user, history()]
      const conversion = toLLMMessagesWithBindings(sourceMessages, roomyModel)
      const request = LLM.request({ model: roomyModel, messages: conversion.messages })
      const generated: LLMRequest[] = []
      const outputs = [candidate, support]
      const client: LLMClientShape = {
        prepare: mockPrepare,
        stream: () => Stream.empty,
        generate: (request) =>
          Effect.sync(() => {
            generated.push(request)
            return response(outputs.shift() ?? "{}")
          }),
      }
      const adapter = CoreReasoningDistillation.make(client)
      const input = {
        sessionID: "ses_scheduled",
        request,
        prepared: yield* prepare(request),
        sourceMessages,
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [compatibility] }),
      }
      const first = yield* adapter.distill(input)
      expect(first.applied).toBe(true)
      expect(first.attempted).toBe("judge")
      expect(generated).toHaveLength(2)
      const nextMessages = [...sourceMessages, { ...user, id: SessionMessage.ID.make("msg_next"), text: "继续" }]
      const nextConversion = toLLMMessagesWithBindings(nextMessages, roomyModel)
      const nextRequest = LLM.request({ model: roomyModel, messages: nextConversion.messages })
      const replay = yield* adapter.distill({
        ...input,
        sourceMessages: nextMessages,
        request: nextRequest,
        prepared: yield* prepare(nextRequest),
        bindings: nextConversion.reasoningBindings,
      })
      expect(replay.applied).toBe(true)
      expect(JSON.stringify(replay.request.messages)).toContain("决定使用安全路径")
      expect(generated).toHaveLength(2)
    }),
  )

  it.effect("invalidates cached judge support when host evidence changes", () =>
    Effect.gen(function* () {
      const source = history()
      const generated: LLMRequest[] = []
      const outputs = [candidate, support]
      const client: LLMClientShape = {
        prepare: () => Effect.die("unused"),
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
        sessionID: "ses_evidence",
        request,
        prepared: yield* prepare(request),
        sourceMessages: [source],
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [compatibility] }),
      }
      yield* adapter.distill(input)
      expect((yield* adapter.distill(input)).applied).toBe(true)
      expect((yield* adapter.distill(input)).applied).toBe(true)
      const changed = {
        ...source,
        content: [...source.content, { type: "text" as const, id: "new-evidence", text: "新证据表明原先推断未验证" }],
      }
      const result = yield* adapter.distill({ ...input, sourceMessages: [changed] })
      expect(result.applied).toBe(false)
      expect(result.request).toBe(request)
      expect(generated).toHaveLength(2)
    }),
  )

  it.effect("does not call an auxiliary model without compatibility proof or for signed reasoning", () =>
    Effect.gen(function* () {
      let calls = 0
      const client: LLMClientShape = {
        prepare: mockPrepare,
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
        prepare: mockPrepare,
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
        prepare: mockPrepare,
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
        prepare: mockPrepare,
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
        prepare: mockPrepare,
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
      const secondText = `第二个决定：保留回滚路径。${"第二段背景。".repeat(4_000)}`
      const source = {
        ...history(),
        content: [...history().content, { type: "reasoning" as const, id: "reasoning-2", text: secondText }],
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
        JSON.stringify({
          retention: { verdict: "supported" },
          support: [{ claimID: "claim-2", verdict: "supported", method: "judged" }],
        }),
      ]
      const client: LLMClientShape = {
        prepare: mockPrepare,
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
      snapshots.push([projected.includes("决定使用安全路径"), projected.includes("决定保留回滚路径")])
      expect(snapshots).toEqual([
        [false, false],
        [true, false],
        [true, false],
        [true, true],
      ])
      expect(generated).toHaveLength(4)
    }),
  )

  const turnSource = (index: number): SessionMessage.Assistant => ({
    ...history(),
    id: SessionMessage.ID.make(`msg_turn_${index}`),
    content: [
      {
        type: "reasoning",
        id: `reasoning-turn-${index}`,
        text: `第 ${index} 轮：先猜测原因是缓存，再看看日志。确认真实原因是权限不足，最终决定改用安全路径并保留回滚步骤。`,
      },
    ],
  })

  const distillTurn = (
    adapter: ReturnType<typeof CoreReasoningDistillation.make>,
    sessionID: string,
    index: number,
    auxiliaryModel: Model = model,
  ) =>
    Effect.gen(function* () {
      const source = turnSource(index)
      const conversion = toLLMMessagesWithBindings([source], model)
      const request = LLM.request({ model, messages: conversion.messages })
      return yield* adapter.distill({
        target: "canonical",
        sessionID,
        request,
        auxiliaryModel,
        prepared: yield* prepare(request),
        sourceMessages: [source],
        bindings: conversion.reasoningBindings,
        config: new ConfigReasoningDistillation.Info({ compatibility: [] }),
      })
    })

  it.effect("reconciles reservations with reported usage so long sessions keep distilling", () =>
    Effect.gen(function* () {
      let calls = 0
      const adapter = CoreReasoningDistillation.make({
        prepare: mockPrepare,
        stream: () => Stream.empty,
        generate: () =>
          Effect.sync(() => {
            calls++
            return response("决定改用安全路径。", 300)
          }),
      })
      for (let index = 1; index <= 20; index++) {
        const result = yield* distillTurn(adapter, "ses_long_session", index)
        expect(result.applied).toBe(true)
        expect(result.usage?.paidAdmissionPaused).toBe(false)
      }
      expect(calls).toBe(20)
    }),
  )

  it.effect("refunds a call without a response and pauses only after consecutive failures", () =>
    Effect.gen(function* () {
      let mode: "fail" | "ok" = "fail"
      let calls = 0
      const adapter = CoreReasoningDistillation.make({
        prepare: mockPrepare,
        stream: () => Stream.empty,
        generate: () =>
          Effect.suspend(() => {
            calls++
            return mode === "fail" ? Effect.die(new Error("timeout")) : Effect.succeed(response("决定改用安全路径。"))
          }),
      })
      const failed = yield* distillTurn(adapter, "ses_failures", 1)
      expect(failed.applied).toBe(false)
      expect(failed.usage).toMatchObject({ reservedTokens: 0, paidAdmissionPaused: false })
      mode = "ok"
      expect((yield* distillTurn(adapter, "ses_failures", 2)).applied).toBe(true)
      mode = "fail"
      for (const index of [3, 4])
        expect((yield* distillTurn(adapter, "ses_failures", index)).usage?.paidAdmissionPaused).toBe(false)
      expect((yield* distillTurn(adapter, "ses_failures", 5)).usage?.paidAdmissionPaused).toBe(true)
      const before = calls
      const paused = yield* distillTurn(adapter, "ses_failures", 6)
      expect(paused.skipReason).toBe("call-budget-exhausted")
      expect(calls).toBe(before)
    }),
  )

  it.effect("keeps a declared no-reasoning variant and uses the configured auxiliary timeout", () =>
    Effect.gen(function* () {
      const generated: LLMRequest[] = []
      const adapter = CoreReasoningDistillation.make({
        prepare: mockPrepare,
        stream: () => Stream.empty,
        generate: (request) =>
          Effect.sync(() => {
            generated.push(request)
            return response("决定改用安全路径。")
          }),
      })
      const none = Model.make({
        id: "small-none",
        provider: "distillation-provider",
        route: model.route.with({ http: { body: { reasoning_effort: "none" } } }),
      })
      const previous = process.env.OPENCODE_REASONING_DISTILLATION_AUX_TIMEOUT_MS
      process.env.OPENCODE_REASONING_DISTILLATION_AUX_TIMEOUT_MS = "45000"
      try {
        yield* distillTurn(adapter, "ses_none_variant", 1, none)
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_REASONING_DISTILLATION_AUX_TIMEOUT_MS
        else process.env.OPENCODE_REASONING_DISTILLATION_AUX_TIMEOUT_MS = previous
      }
      expect(generated).toHaveLength(1)
      expect(generated[0].http?.body).toBeUndefined()
      expect(generated[0].providerOptions).toBeUndefined()
      expect(Duration.toMillis(Duration.fromInputUnsafe(generated[0].http!.timeout!))).toBe(45_000)
    }),
  )
})
