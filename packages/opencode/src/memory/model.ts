export * as MemoryModel from "./model"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { generateObject } from "ai"
import { Provider } from "@/provider/provider"

const DEFAULT_TIMEOUT = Duration.seconds(8)

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
    generate: Effect.fn("MemoryModel.generate")((request) =>
      input.execute(request).pipe(
        Effect.timeoutOrElse({
          duration: input.timeout ?? DEFAULT_TIMEOUT,
          orElse: () => Effect.fail(new TimeoutError()),
        }),
      ),
    ),
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    return make({
      execute: Effect.fnUntraced(function* (input) {
        const language = yield* provider.getLanguage(input.model)
        const schema = Object.assign(
          Schema.toStandardSchemaV1(input.schema),
          Schema.toStandardJSONSchemaV1(input.schema),
        )
        return yield* Effect.tryPromise({
          try: (signal) =>
            generateObject({
              model: language,
              system: input.system,
              prompt: input.prompt,
              schema,
              temperature: input.model.capabilities.temperature ? 0 : undefined,
              maxOutputTokens: input.maxOutputTokens,
              abortSignal: signal,
            }).then((result) => result.object),
          catch: (cause) => new GenerateError({ cause }),
        })
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Provider.defaultLayer))

export const node = LayerNode.make(layer, [Provider.node])
