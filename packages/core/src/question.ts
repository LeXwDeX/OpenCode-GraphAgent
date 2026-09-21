export * as QuestionV2 from "./question"

import { Clock, Context, Deferred, Effect, Layer, Option as EffectOption, Schema } from "effect"
import { Question } from "@opencode-ai/schema/question"
import { EventV2 } from "./event"
import { SessionSchema } from "./session/schema"
import { Config } from "./config"

export const DEFAULT_TIMEOUT_SECONDS = 60

export const ID = Question.ID
export type ID = typeof ID.Type

export const Option = Question.Option
export type Option = typeof Option.Type

export const Info = Question.Info
export type Info = typeof Info.Type

export const Prompt = Question.Prompt
export type Prompt = typeof Prompt.Type

export const Tool = Question.Tool
export type Tool = typeof Tool.Type

export const Request = Question.Request
export type Request = typeof Request.Type

export const Answer = Question.Answer
export type Answer = typeof Answer.Type

export const Reply = Question.Reply
export type Reply = typeof Reply.Type

export const Event = Question.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionV2.RejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class TimedOutError extends Schema.TaggedErrorClass<TimedOutError>()("QuestionV2.TimedOutError", {}) {
  override get message() {
    return "The user is temporarily away"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("QuestionV2.NotFoundError", {
  requestID: ID,
}) {}

export interface AskInput {
  readonly sessionID: SessionSchema.ID
  readonly questions: ReadonlyArray<Info>
  readonly tool?: Tool
}

export interface ReplyInput {
  readonly requestID: ID
  readonly answers: ReadonlyArray<Answer>
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<ReadonlyArray<Answer>, RejectedError | TimedOutError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: ID) => Effect.Effect<void, NotFoundError>
  readonly interact: (requestID: ID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Question") {}

interface Pending {
  request: Request
  readonly deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
}

/**
 * Location-owned pending prompts. The Location layer map must materialize this
 * layer once per embedded Location so replies cannot settle another Location's
 * deferred request.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const config = EffectOption.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const pending = new Map<ID, Pending>()

    yield* Effect.addFinalizer(() =>
      Effect.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new RejectedError()), {
        discard: true,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const ask = Effect.fn("QuestionV2.ask")((input: AskInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const id = ID.ascending()
          const timeoutSeconds = config
            ? (Config.latest(yield* config.entries(), "question_timeout") ?? DEFAULT_TIMEOUT_SECONDS)
            : DEFAULT_TIMEOUT_SECONDS
          const now = yield* Clock.currentTimeMillis
          const expiresAt = now + timeoutSeconds * 1_000
          const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
          const request: Request = { id, ...input, expiresAt }
          const entry = { request, deferred }
          pending.set(id, entry)
          return yield* events.publish(Event.Asked, request).pipe(
            Effect.andThen(
              restore(
                Effect.raceFirst(
                  Deferred.await(deferred),
                  Effect.gen(function* () {
                    const current = yield* Clock.currentTimeMillis
                    yield* Effect.sleep(Math.max(0, expiresAt - current))
                    const timedOut = yield* Effect.uninterruptible(
                      Effect.gen(function* () {
                        const existing = pending.get(id)
                        if (existing !== entry || existing.request.expiresAt === undefined) return false
                        pending.delete(id)
                        yield* events.publish(Event.TimedOut, { sessionID: request.sessionID, requestID: id })
                        return true
                      }),
                    )
                    if (!timedOut) return yield* Effect.never
                    return yield* new TimedOutError()
                  }),
                ),
              ),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = Effect.fn("QuestionV2.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) {
            yield* new NotFoundError({ requestID: input.requestID })
            return
          }
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            answers: input.answers.map((answer) => [...answer]),
          })
          yield* Deferred.succeed(existing.deferred, input.answers)
          pending.delete(input.requestID)
        }),
      ),
    )

    const reject = Effect.fn("QuestionV2.reject")((requestID: ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(requestID)
          if (!existing) {
            yield* new NotFoundError({ requestID })
            return
          }
          yield* events.publish(Event.Rejected, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
          })
          yield* Deferred.fail(existing.deferred, new RejectedError())
          pending.delete(requestID)
        }),
      ),
    )

    const interact = Effect.fn("QuestionV2.interact")((requestID: ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(requestID)
          if (!existing) {
            yield* new NotFoundError({ requestID })
            return
          }
          if (existing.request.expiresAt === undefined) return
          existing.request = { ...existing.request, expiresAt: undefined }
          yield* events.publish(Event.Interacted, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
          })
        }),
      ),
    )

    const list = Effect.fn("QuestionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    return Service.of({ ask, reply, reject, interact, list })
  }),
)

export const locationLayer = layer
