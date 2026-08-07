import { describe, expect, test } from "bun:test"
import { Cause, Duration, Effect, Exit, Fiber, Option, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LLM, LLMError, LLMEvent } from "../src"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { HttpOptions, Model, mergeHttpOptions } from "../src/schema"
import { LLMClient } from "../src/route"
import { testEffect } from "./lib/effect"
import { dynamicResponse, fixedResponse } from "./lib/http"
import { deltaChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })

const request = (timeout?: number) =>
  LLM.request({
    model,
    prompt: "Say hello.",
    http: timeout === undefined ? undefined : { timeout: Duration.millis(timeout) },
  })

const hangingHeaders = dynamicResponse(() => Effect.never)

const hangingBody = dynamicResponse((input) =>
  Effect.sync(() =>
    input.respond(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } }),
  ),
)

const expectTimeoutExit = (exit: Exit.Exit<readonly LLMEvent[], LLMError>) => {
  if (Exit.isSuccess(exit)) {
    throw new Error(`expected a Timeout failure, stream completed with ${exit.value.length} events`)
  }
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
  expect(error).toBeInstanceOf(LLMError)
  if (!(error instanceof LLMError)) throw new Error("expected LLMError")
  expect(error.reason).toMatchObject({ _tag: "Transport", kind: "Timeout" })
}

describe("http transport timeout", () => {
  testEffect(hangingHeaders).effect(
    "ends the stream with a Timeout error when the provider never sends response headers",
    () =>
      Effect.gen(function* () {
        const fiber = yield* LLMClient.stream(request(1000)).pipe(Stream.runCollect, Effect.forkChild)
        yield* TestClock.adjust(2000)
        expectTimeoutExit(yield* Fiber.join(fiber).pipe(Effect.exit))
      }),
  )

  testEffect(hangingBody).effect(
    "ends the stream with a Timeout error when the response body never emits",
    () =>
      Effect.gen(function* () {
        const fiber = yield* LLMClient.stream(request(1000)).pipe(Stream.runCollect, Effect.forkChild)
        yield* TestClock.adjust(2000)
        expectTimeoutExit(yield* Fiber.join(fiber).pipe(Effect.exit))
      }),
  )

  testEffect(fixedResponse(sseEvents(deltaChunk({ role: "assistant", content: "Hello" })))).effect(
    "completes normally when the stream finishes within the timeout",
    () =>
      Effect.gen(function* () {
        const events = yield* LLMClient.stream(request(1000)).pipe(Stream.runCollect)
        expect(events.some(LLMEvent.is.textDelta)).toBe(true)
      }),
  )

  testEffect(hangingHeaders).effect(
    "applies the route default timeout when the request omits http",
    () =>
      Effect.gen(function* () {
        const defaultModel = Model.make({
          id: "fake-model",
          provider: "fake",
          route: OpenAIChat.route.with({ http: { timeout: Duration.millis(500) } }),
        })
        const fiber = yield* LLMClient.stream(LLM.request({ model: defaultModel, prompt: "Say hello." })).pipe(
          Stream.runCollect,
          Effect.forkChild,
        )
        yield* TestClock.adjust(1000)
        expectTimeoutExit(yield* Fiber.join(fiber).pipe(Effect.exit))
      }),
  )
})

describe("HttpOptions.timeout merging", () => {
  test("keeps existing merge behavior when no timeout is set", () => {
    expect(mergeHttpOptions(new HttpOptions({ headers: { "x-a": "1" } }), undefined)).toEqual(
      new HttpOptions({ headers: { "x-a": "1" } }),
    )
    expect(mergeHttpOptions()).toBeUndefined()
    expect(new HttpOptions({ headers: { "x-a": "1" } }).timeout).toBeUndefined()
  })

  test("merges timeout with last-wins semantics", () => {
    const merged = mergeHttpOptions(
      new HttpOptions({ timeout: Duration.millis(1000) }),
      new HttpOptions({ headers: { "x-a": "1" }, timeout: Duration.millis(2500) }),
      undefined,
    )
    expect(merged?.headers).toEqual({ "x-a": "1" })
    expect(Duration.toMillis(merged?.timeout ?? Duration.zero)).toBe(2500)
  })
})
