export * as MemoryModel from "./model"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { streamObject } from "ai"
import { Provider } from "@/provider/provider"

// Liveness is judged per-chunk, never by a whole-call wall clock: a stream
// that keeps delivering parts is alive, however long the reasoning runs.
// CONNECT_TIMEOUT bounds the wait for the FIRST part; IDLE_TIMEOUT bounds the
// silence BETWEEN parts and is re-armed by every arriving part. Generation
// still terminates on its own via max_output_tokens / a natural stop.
const CONNECT_TIMEOUT = Duration.seconds(60)
const IDLE_TIMEOUT = Duration.seconds(60)

const JSON_HINT = "Respond with a JSON object matching the provided schema."

export interface Request {
  readonly model: Provider.Model
  readonly system: string
  readonly prompt: string
  readonly schema: Schema.Decoder<unknown>
  readonly maxOutputTokens: number
}

export interface Interface {
  readonly generate: (input: Request) => Effect.Effect<unknown, ModelError>
}

export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()("MemoryModel.TimeoutError", {}) {
  override get message() {
    return "MEMORY model call timed out"
  }
}

export class GenerateError extends Schema.TaggedErrorClass<GenerateError>()("MemoryModel.GenerateError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return `MEMORY model call failed: ${String(this.cause)}`
  }
}

export type ModelError = TimeoutError | GenerateError | Provider.ModelNotFoundError

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryModel") {}

export function make(input: {
  readonly execute: (request: Request) => Effect.Effect<unknown, ModelError>
  readonly timeout?: Duration.Input
}) {
  return Service.of({
    generate: Effect.fn("MemoryModel.generate")((request) => {
      const effect = input.execute(requireJsonToken(request))
      // An injected timeout (tests) stays a hard deadline; production relies on
      // the per-chunk liveness below, so an actively streaming call is never
      // killed by a wall clock.
      if (input.timeout === undefined) return effect
      return effect.pipe(
        Effect.timeoutOrElse({
          duration: input.timeout,
          orElse: () => Effect.fail(new TimeoutError()),
        }),
      )
    }),
  })
}

// Providers serving response_format json_object reject prompts that do not
// contain the literal word "json"; the maintenance prompts never mention it.
function requireJsonToken(request: Request): Request {
  if (/json/i.test(request.system) || /json/i.test(request.prompt)) return request
  return { ...request, system: `${request.system}\n${JSON_HINT}` }
}

// Signals that the stream went silent past the liveness window.
export class Stalled extends Error {}

// Drains `parts`, re-arming the idle watchdog on EVERY part (so a live stream
// that keeps delivering — reasoning deltas included — never trips the timer).
// Arms `connectTimeout` until the first part and `idleTimeout` between parts;
// a silent window invokes `onStall` (abort the request) and fails with
// `Stalled`, while an `errorOf` hit fails with that part's error.
export const drainWithLiveness = <T>(input: {
  parts: AsyncIterable<T>
  connectTimeout: Duration.Duration
  idleTimeout: Duration.Duration
  onStall: () => void
  errorOf: (part: T) => unknown | undefined
}) =>
  new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      action()
    }
    const arm = (duration: Duration.Duration) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(
        () =>
          finish(() => {
            input.onStall()
            reject(new Stalled())
          }),
        Duration.toMillis(duration),
      )
    }
    arm(input.connectTimeout)
    void (async () => {
      try {
        for await (const part of input.parts) {
          arm(input.idleTimeout)
          const error = input.errorOf(part)
          if (error !== undefined) throw error
        }
        finish(resolve)
      } catch (cause) {
        finish(() => reject(cause))
      }
    })()
  })

const streamGenerate = (input: {
  language: Parameters<typeof streamObject>[0]["model"]
  system: string
  prompt: string
  schema: Schema.Decoder<unknown>
  temperature?: number
  maxOutputTokens: number
  connectTimeout: Duration.Duration
  idleTimeout: Duration.Duration
}) =>
  Effect.tryPromise({
    try: (signal) =>
      (async () => {
        const controller = new AbortController()
        const forwardAbort = () => controller.abort()
        signal.addEventListener("abort", forwardAbort)
        try {
          const result = streamObject({
            model: input.language,
            system: input.system,
            prompt: input.prompt,
            schema: Object.assign(
              Schema.toStandardSchemaV1(input.schema),
              Schema.toStandardJSONSchemaV1(input.schema),
            ),
            temperature: input.temperature,
            maxOutputTokens: input.maxOutputTokens,
            abortSignal: controller.signal,
            onError: () => {},
          })
          await drainWithLiveness({
            parts: result.fullStream,
            connectTimeout: input.connectTimeout,
            idleTimeout: input.idleTimeout,
            onStall: () => controller.abort(),
            errorOf: (part) => (part.type === "error" ? part.error : undefined),
          })
          return await result.object
        } finally {
          signal.removeEventListener("abort", forwardAbort)
        }
      })(),
    catch: (cause) => (cause instanceof Stalled ? new TimeoutError() : new GenerateError({ cause })),
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    return make({
      execute: Effect.fnUntraced(function* (input) {
        const language = yield* provider.getLanguage(input.model)
        return yield* streamGenerate({
          language,
          system: input.system,
          prompt: input.prompt,
          schema: input.schema,
          temperature: input.model.capabilities.temperature ? 0 : undefined,
          maxOutputTokens: input.maxOutputTokens,
          connectTimeout: CONNECT_TIMEOUT,
          idleTimeout: IDLE_TIMEOUT,
        })
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Provider.defaultLayer))

export const node = LayerNode.make(layer, [Provider.node])
