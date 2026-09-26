import { describe, expect } from "bun:test"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config"
import { EventV2 } from "@opencode-ai/core/event"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionV2 } from "@opencode-ai/core/session"
import { testEffect } from "./lib/effect"

const questions = QuestionV2.layer.pipe(Layer.provide(EventV2.defaultLayer))
const it = testEffect(Layer.mergeAll(Database.defaultLayer, EventV2.defaultLayer, questions))
const longTimeoutConfig = Layer.mock(Config.Service)({
  entries: () =>
    Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({ question_timeout: 600 }) })]),
})
const longTimeoutQuestions = QuestionV2.layer.pipe(
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(longTimeoutConfig),
)
const longTimeoutIt = testEffect(Layer.mergeAll(Database.defaultLayer, EventV2.defaultLayer, longTimeoutQuestions))

const sessionID = SessionV2.ID.make("ses_question_test")
const question: QuestionV2.Info = {
  question: "Which option?",
  header: "Option",
  options: [{ label: "One", description: "First option" }],
}

const waitForAsk = Effect.fn("QuestionV2Test.waitForAsk")(function* (
  service: QuestionV2.Interface,
  input: QuestionV2.AskInput,
) {
  const events = yield* EventV2.Service
  const asked = yield* Deferred.make<QuestionV2.Request>()
  const unsubscribe = yield* events.listen((event) =>
    event.type === QuestionV2.Event.Asked.type
      ? Deferred.succeed(asked, event.data as QuestionV2.Request).pipe(Effect.asVoid)
      : Effect.void,
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  const fiber = yield* service.ask(input).pipe(Effect.forkScoped)
  return { fiber, request: yield* Deferred.await(asked) }
})

describe("QuestionV2", () => {
  it.effect("times out deterministically and removes the pending request", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const timedOut = yield* Deferred.make<void>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === QuestionV2.Event.TimedOut.type
          ? Deferred.succeed(timedOut, undefined).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      expect(request.expiresAt).toBe(60_000)
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.seconds(60))
      yield* Deferred.await(timedOut)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("QuestionV2.TimedOutError")
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("expires after interaction inactivity and refuses a late reply", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question, question] })

      yield* service.interact(request.id)
      expect((yield* service.list())[0]?.expiresAt).toBeUndefined()
      yield* TestClock.adjust(Duration.seconds(59))
      yield* service.interact(request.id)
      yield* TestClock.adjust(Duration.seconds(59))
      expect(yield* service.list()).toHaveLength(1)
      yield* TestClock.adjust(Duration.seconds(1))
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("QuestionV2.TimedOutError")
      expect(yield* service.list()).toEqual([])
      expect(yield* service.reply({ requestID: request.id, answers: [["One"], ["One"]] }).pipe(Effect.flip)).toEqual(
        new QuestionV2.NotFoundError({ requestID: request.id }),
      )
    }),
  )

  it.effect("caps the response phase even when interactions keep refreshing inactivity", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })
      yield* service.interact(request.id)
      for (let interval = 0; interval < 9; interval++) {
        yield* TestClock.adjust(Duration.seconds(30))
        yield* service.interact(request.id)
      }
      yield* TestClock.adjust(Duration.seconds(30))
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  longTimeoutIt.effect("observes a response cap shorter than the original configured timeout", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })
      expect(request.expiresAt).toBe(600_000)
      yield* service.interact(request.id)
      yield* TestClock.adjust(Duration.seconds(299))
      expect(yield* service.list()).toHaveLength(1)
      yield* TestClock.adjust(Duration.seconds(1))
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("removes a pending request when its ask fiber is interrupted", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const { fiber } = yield* waitForAsk(service, { sessionID, questions: [question] })
      yield* Fiber.interrupt(fiber)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("publishes lifecycle events and settles a pending reply", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type.startsWith("question.v2.")) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      expect(request.id).toMatch(/^que_/)
      expect(yield* service.list()).toEqual([request])
      yield* service.reply({ requestID: request.id, answers: [["One"]] })

      expect(yield* Fiber.join(fiber)).toEqual([["One"]])
      expect(yield* service.list()).toEqual([])
      expect(published.map((event) => [event.type, event.data])).toEqual([
        [QuestionV2.Event.Asked.type, request],
        [QuestionV2.Event.Replied.type, { sessionID, requestID: request.id, answers: [["One"]] }],
      ])
    }),
  )

  it.effect("publishes rejection, fails the ask, and rejects unknown IDs", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === QuestionV2.Event.Rejected.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      yield* service.reject(request.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("QuestionV2.RejectedError")
      expect(published.map((event) => event.data)).toEqual([{ sessionID, requestID: request.id }])

      const unknown = QuestionV2.ID.ascending("que_unknown")
      expect(yield* service.reply({ requestID: unknown, answers: [] }).pipe(Effect.flip)).toEqual(
        new QuestionV2.NotFoundError({ requestID: unknown }),
      )
      expect(yield* service.reject(unknown).pipe(Effect.flip)).toEqual(
        new QuestionV2.NotFoundError({ requestID: unknown }),
      )
    }),
  )

  it.effect("isolates pending requests by location-layer instance and rejects them on finalization", () =>
    Effect.gen(function* () {
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      const first = Context.get(yield* Layer.buildWithScope(Layer.fresh(questions), firstScope), QuestionV2.Service)
      const second = Context.get(yield* Layer.buildWithScope(Layer.fresh(questions), secondScope), QuestionV2.Service)
      const fiber = yield* first.ask({ sessionID, questions: [question] }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const request = (yield* first.list())[0]!

      expect(yield* second.list()).toEqual([])
      expect(yield* second.reply({ requestID: request.id, answers: [["One"]] }).pipe(Effect.flip)).toEqual(
        new QuestionV2.NotFoundError({ requestID: request.id }),
      )

      yield* Scope.close(firstScope, Exit.void)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("QuestionV2.RejectedError")
      yield* Scope.close(secondScope, Exit.void)
    }),
  )
})
