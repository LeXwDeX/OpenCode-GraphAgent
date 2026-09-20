import { describe, expect } from "bun:test"
import { LLM, Message, Model, PreparedRequest, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { CoreContextFolding } from "@opencode-ai/core/session/runner/context-folding"
import { toLLMMessagesWithBindings } from "@opencode-ai/core/session/runner/to-llm-message"
import { ContextFoldingToolSourceLedger } from "@opencode-ai/core/session/context-folding/tool-source-ledger"
import { DateTime, Effect } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(ContextFoldingToolSourceLedger.layer)
const model = Model.make({
  id: "folding-model",
  provider: "folding-provider",
  route: OpenAIChat.route,
  defaults: { limits: { context: 40_000, output: 1_000 } },
})
const modelRef = {
  id: ModelV2.ID.make(String(model.id)),
  providerID: ProviderV2.ID.make(String(model.provider)),
}
const body = "same-output:" + "x".repeat(20_000)
const now = DateTime.makeUnsafe(1)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const textPage = (overrides: Record<string, unknown> = {}) => ({
  type: "text-page",
  content: body,
  mime: "text/plain",
  offset: 1,
  truncated: false,
  next: 2,
  ...overrides,
})

const toolMessage = (input: {
  messageID: string
  callID: string
  toolName?: string
  toolInput?: Record<string, unknown>
  structured?: Record<string, unknown>
  content?: SessionMessage.ToolStateCompleted["content"]
  status?: "completed" | "running" | "error"
  messageMetadata?: Record<string, unknown>
  providerMetadata?: Record<string, Record<string, unknown>>
}): SessionMessage.Assistant => {
  const status = input.status ?? "completed"
  const state: SessionMessage.AssistantTool["state"] =
    status === "completed"
      ? {
          status,
          input: input.toolInput ?? { path: "notes.txt", offset: 1, limit: 200 },
          structured: input.structured ?? textPage(),
          content: input.content ?? [],
        }
      : status === "running"
        ? {
            status,
            input: input.toolInput ?? { path: "notes.txt", offset: 1, limit: 200 },
            structured: input.structured ?? textPage(),
            content: input.content ?? [],
          }
        : {
            status,
            input: input.toolInput ?? { path: "notes.txt", offset: 1, limit: 200 },
            structured: input.structured ?? {},
            content: input.content ?? [],
            error: { type: "unknown", message: "failed" },
          }
  return {
    id: SessionMessage.ID.make(input.messageID),
    type: "assistant",
    agent: "build",
    model: modelRef,
    metadata: input.messageMetadata,
    time: { created: now, completed: now },
    content: [
      {
        type: "tool",
        id: input.callID,
        name: input.toolName ?? "read",
        provider:
          input.providerMetadata === undefined
            ? undefined
            : { executed: false, metadata: input.providerMetadata, resultMetadata: input.providerMetadata },
        state,
        time: { created: now, ran: now, completed: now },
      },
    ],
  }
}

const recent = (index: number, textBytes = 20_000): SessionMessage.Assistant => ({
  id: SessionMessage.ID.make(`msg_recent_${index}`),
  type: "assistant",
  agent: "build",
  model: modelRef,
  time: { created: now, completed: now },
  content: [{ type: "text", id: `text-${index}`, text: "recent:" + "r".repeat(textBytes) }],
})

const pair = (
  source: Partial<Parameters<typeof toolMessage>[0]> = {},
  witness: Partial<Parameters<typeof toolMessage>[0]> = {},
) => [
  toolMessage({ messageID: "msg_source", callID: "call-source", ...source }),
  toolMessage({ messageID: "msg_witness", callID: "call-witness", ...witness }),
  ...Array.from({ length: 4 }, (_, index) => recent(index)),
]

const provenance = Effect.fnUntraced(function* (
  ledger: ContextFoldingToolSourceLedger.Interface,
  messages: readonly SessionMessage.Message[],
  instructions: "none" | "dynamic" | "unknown" = "none",
) {
  const generation = yield* ledger.activate([
    { toolName: "read", sourceKind: "host-builtin", registrationID: "builtin-read", instructions },
  ])
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.name !== "read") continue
      yield* ledger.record({
        sessionID: "ses_runner_adapter",
        assistantMessageID: message.id,
        callID: part.id,
        toolName: part.name,
        source: {
          sourceKind: "host-builtin",
          registrationID: "builtin-read",
          registrationGeneration: generation,
          instructions,
        },
      })
    }
  }
})

const plan = Effect.fnUntraced(function* (
  messages: readonly SessionMessage.Message[],
  instructions: "none" | "dynamic" | "unknown" = "none",
) {
  const ledger = yield* ContextFoldingToolSourceLedger.Service
  yield* provenance(ledger, messages, instructions)
  const conversion = toLLMMessagesWithBindings(messages, model)
  const history = yield* CoreContextFolding.history({
    sessionID: "ses_runner_adapter",
    messages,
    conversion,
    model,
    ledger,
  })
  return { history, conversion, ledger }
})

const prepare = (request: LLMRequest) =>
  request.model.route.body.from(request).pipe(
    Effect.map(
      (preparedBody) =>
        new PreparedRequest({
          id: request.id ?? "request",
          route: request.model.route.id,
          protocol: request.model.route.protocol,
          model: request.model,
          body: preparedBody,
        }),
    ),
  )

describe("Core runner context folding adapter", () => {
  it.effect("accepts only complete exact TextPage pairs and binds every outer field", () =>
    Effect.gen(function* () {
      const positive = yield* plan(pair())
      expect(positive.history.duplicatePlan.replacements).toEqual([
        {
          source: { messageID: "msg_source", partID: "call-source", callID: "call-source" },
          witness: { messageID: "msg_witness", partID: "call-witness", callID: "call-witness" },
        },
      ])

      const variants: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
        ["type", { type: "unknown" }, {}],
        ["mime", { mime: "text/markdown" }, {}],
        ["offset", { offset: 2 }, {}],
        ["next", { next: 3 }, {}],
        ["content", { content: body + "changed" }, {}],
        ["extra field", { checksum: "unexpected" }, { checksum: "unexpected" }],
      ]
      for (const [name, source, witness] of variants) {
        const result = yield* plan(pair({ structured: textPage(source) }, { structured: textPage(witness) }))
        expect(result.history.duplicatePlan.replacements, name).toEqual([])
      }

      const truncated = yield* plan(
        pair({ structured: textPage({ truncated: true }) }, { structured: textPage({ truncated: true }) }),
      )
      expect(truncated.history.duplicatePlan.replacements).toEqual([])
      expect(truncated.history.duplicatePlan.exclusions.map((item) => item.reason)).toContain("incomplete-content")
    }),
  )

  it.effect("rejects list, binary, media, failed, running, dynamic, and unknown-instruction results", () =>
    Effect.gen(function* () {
      const fixtures: Array<[string, readonly SessionMessage.Message[], "none" | "dynamic" | "unknown"]> = [
        [
          "list",
          pair({ structured: { entries: [], truncated: false } }, { structured: { entries: [], truncated: false } }),
          "none",
        ],
        [
          "binary",
          pair(
            {
              structured: {
                uri: "file:///a.bin",
                content: "AA==",
                encoding: "base64",
                mime: "application/octet-stream",
              },
            },
            {
              structured: {
                uri: "file:///a.bin",
                content: "AA==",
                encoding: "base64",
                mime: "application/octet-stream",
              },
            },
          ),
          "none",
        ],
        [
          "media",
          pair(
            { content: [{ type: "file", uri: "data:image/png;base64,AA==", mime: "image/png" }] },
            { content: [{ type: "file", uri: "data:image/png;base64,AA==", mime: "image/png" }] },
          ),
          "none",
        ],
        ["failed", pair({ status: "error" }, { status: "error" }), "none"],
        ["running", pair({ status: "running" }, { status: "running" }), "none"],
        [
          "dynamic body",
          pair(
            { structured: textPage({ content: `<system-reminder>${body}` }) },
            { structured: textPage({ content: `<system-reminder>${body}` }) },
          ),
          "none",
        ],
        ["dynamic marker", pair(), "dynamic"],
        ["unknown marker", pair(), "unknown"],
      ]
      for (const [name, messages, instructions] of fixtures) {
        const result = yield* plan(messages, instructions)
        expect(result.history.duplicatePlan.replacements, name).toEqual([])
      }
    }),
  )

  it.effect("rejects captured history after input, body, metadata, order, deletion, or cross-tool ID mutation", () =>
    Effect.gen(function* () {
      const messages = pair()
      const { history, conversion } = yield* plan(messages)
      expect(CoreContextFolding.bindHistory(history, conversion.messages, messages)).toBeDefined()

      const changedInput = structuredClone(conversion.messages)
      const changedInputPart = changedInput[0].content[0]
      if (changedInputPart.type !== "tool-call" || !isRecord(changedInputPart.input))
        throw new Error("expected tool call")
      changedInputPart.input.path = "other.txt"
      expect(CoreContextFolding.bindHistory(history, changedInput, messages)).toBeUndefined()

      const changedBody = structuredClone(conversion.messages)
      const changedBodyPart = changedBody[1].content[0]
      if (
        changedBodyPart.type !== "tool-result" ||
        changedBodyPart.result.type !== "json" ||
        !isRecord(changedBodyPart.result.value)
      )
        throw new Error("expected JSON tool result")
      changedBodyPart.result.value.mime = "text/markdown"
      expect(CoreContextFolding.bindHistory(history, changedBody, messages)).toBeUndefined()

      const changedMetadata = structuredClone(messages)
      changedMetadata.splice(0, 1, { ...changedMetadata[0], metadata: { changed: true } })
      expect(CoreContextFolding.bindHistory(history, conversion.messages, changedMetadata)).toBeUndefined()

      const changedOuter = structuredClone(messages)
      const changedOuterTool = changedOuter[0].content[0]
      if (changedOuterTool.type !== "tool") throw new Error("expected tool part")
      if (changedOuterTool.state.status !== "completed") throw new Error("expected completed tool")
      changedOuter.splice(0, 1, {
        ...changedOuter[0],
        content: [
          {
            ...changedOuterTool,
            state: {
              ...changedOuterTool.state,
              attachments: [{ uri: "file:///changed", mime: "text/plain" }],
            },
          },
        ],
      })
      expect(CoreContextFolding.bindHistory(history, conversion.messages, changedOuter)).toBeUndefined()

      const reordered = structuredClone(conversion.messages)
      reordered.splice(0, 4, reordered[2], reordered[3], reordered[0], reordered[1])
      expect(CoreContextFolding.bindHistory(history, reordered, messages)).toBeUndefined()

      const deleted = structuredClone(conversion.messages)
      deleted.splice(1, 1)
      expect(CoreContextFolding.bindHistory(history, deleted, messages)).toBeUndefined()

      const collision = structuredClone(conversion.messages)
      const collisionMessage = collision[2]
      collision.splice(
        2,
        1,
        Message.make({
          id: collisionMessage.id,
          role: collisionMessage.role,
          content: [
            ...collisionMessage.content,
            { type: "tool-call", id: "call-source", name: "glob", input: { pattern: "*" } },
          ],
          metadata: collisionMessage.metadata,
        }),
      )
      expect(CoreContextFolding.bindHistory(history, collision, messages)).toBeUndefined()
    }),
  )

  it.effect(
    "projects only conversation requests and leaves disabled, compaction, auxiliary, and unknown purposes untouched",
    () =>
      Effect.gen(function* () {
        const messages = pair()
        const { conversion, ledger } = yield* plan(messages)
        const request = LLM.request({ model, messages: conversion.messages, tools: [] })
        const base = {
          sessionID: "ses_runner_adapter",
          sourceMessages: messages,
          conversion,
          expectedMessages: conversion.messages,
          model,
          request,
          ledger,
          prepare,
        }

        const projected = yield* CoreContextFolding.project({ ...base, enabled: true, purpose: "conversation" })
        expect(projected.applied).toBe(true)
        expect(JSON.stringify((yield* prepare(projected.request)).body)).toContain("Duplicate tool output folded")

        for (const [enabled, purpose] of [
          [false, "conversation"],
          [true, "compaction"],
          [true, "auxiliary"],
          [true, "unknown"],
        ] as const) {
          let prepares = 0
          const skipped = yield* CoreContextFolding.project({
            ...base,
            enabled,
            purpose,
            prepare: (value) => Effect.sync(() => prepares++).pipe(Effect.andThen(prepare(value))),
          })
          expect(skipped.applied, purpose).toBe(false)
          expect(skipped.request, purpose).toBe(request)
          expect(prepares, purpose).toBe(0)
        }
      }),
  )

  it.effect("projects a 7.5 MiB prepared request and still fails closed on a stale large binding", () =>
    Effect.gen(function* () {
      const targetBytes = 7_500_000
      let fillerBytes = targetBytes - body.length * 2 - 2_000
      let messages: readonly SessionMessage.Message[] = []
      let conversion: ReturnType<typeof toLLMMessagesWithBindings> | undefined
      let request: LLMRequest | undefined
      let prepared: PreparedRequest | undefined
      for (let attempt = 0; attempt < 4; attempt++) {
        const base = Math.floor(fillerBytes / 4)
        const remainder = fillerBytes - base * 4
        messages = [
          toolMessage({ messageID: "msg_large_source", callID: "call-large-source" }),
          toolMessage({ messageID: "msg_large_witness", callID: "call-large-witness" }),
          ...Array.from({ length: 4 }, (_, index) => recent(index, base + (index === 0 ? remainder : 0))),
        ]
        conversion = toLLMMessagesWithBindings(messages, model)
        request = LLM.request({ model, messages: conversion.messages, tools: [] })
        prepared = yield* prepare(request)
        const delta = targetBytes - Buffer.byteLength(JSON.stringify(prepared.body))
        if (delta === 0) break
        fillerBytes += delta
      }
      if (!conversion || !request || !prepared) throw new Error("large fixture construction failed")
      expect(Buffer.byteLength(JSON.stringify(prepared.body))).toBe(targetBytes)

      const ledger = yield* ContextFoldingToolSourceLedger.Service
      yield* provenance(ledger, messages)
      const original = JSON.stringify({ messages, request })
      const projected = yield* CoreContextFolding.project({
        enabled: true,
        purpose: "conversation",
        sessionID: "ses_runner_adapter",
        sourceMessages: messages,
        conversion,
        expectedMessages: conversion.messages,
        model,
        request,
        ledger,
        prepare,
      })
      expect(projected.applied).toBe(true)
      expect(projected.plan.replacements).toHaveLength(1)
      expect(projected.plan.skipReason).toBeUndefined()
      expect(JSON.stringify({ messages, request })).toBe(original)
      const projectedBody = JSON.stringify((yield* prepare(projected.request)).body)
      expect(Buffer.byteLength(projectedBody)).toBeLessThan(targetBytes)
      expect(projectedBody.split(body)).toHaveLength(2)

      const staleExpected = structuredClone(conversion.messages)
      const staleResult = staleExpected[3]?.content[0]
      if (staleResult?.type !== "tool-result" || staleResult.result.type !== "json") {
        throw new Error("expected large witness result")
      }
      if (!isRecord(staleResult.result.value)) throw new Error("expected large witness JSON")
      staleResult.result.value.content = `${body}-changed`
      const rejected = yield* CoreContextFolding.project({
        enabled: true,
        purpose: "conversation",
        sessionID: "ses_runner_adapter",
        sourceMessages: messages,
        conversion,
        expectedMessages: staleExpected,
        model,
        request,
        ledger,
        prepare,
      })
      expect(rejected.applied).toBe(false)
      expect(rejected.request).toBe(request)
      expect(rejected.plan).toMatchObject({ replacements: [], skipReason: "mapping-mismatch" })
      expect(JSON.stringify({ messages, request })).toBe(original)
    }),
  )
})
