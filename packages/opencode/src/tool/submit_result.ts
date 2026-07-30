import * as Tool from "./tool"
import DESCRIPTION from "./submit_result.txt"
import { Effect, Option, Schema } from "effect"
import { validatePayload } from "@/dag/runtime/capture"
import { DagStore } from "@opencode-ai/core/dag/store"

const id = "submit_result"
const parseJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export const Parameters = Schema.Struct({
  payload: Schema.Unknown.annotate({
    description: "JSON value matching the node's declared output_schema (object, array, string, number, or boolean).",
  }),
})

type Metadata = { captured?: boolean }

export const SubmitResultTool = Tool.define<typeof Parameters, Metadata, never>(
  id,
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const storeOpt = yield* Effect.serviceOption(DagStore.Service)
          if (Option.isNone(storeOpt)) {
            return {
              title: "submit_result not applicable",
              output: "submit_result is not available in this session.",
              metadata: {} as Metadata,
            }
          }
          const initial = validatePayload(ctx.sessionID, params.payload)
          const parsed =
            !initial.ok && typeof params.payload === "string" ? parseJsonOption(params.payload) : Option.none()
          const payload = Option.isSome(parsed) ? parsed.value : params.payload
          const result = Option.isSome(parsed) ? validatePayload(ctx.sessionID, payload) : initial
          if (!result.ok) {
            if (result.notAvailable) {
              return {
                title: "submit_result not applicable",
                output: "submit_result has no effect in this session — it is only for DAG workflow child sessions that declared an output_schema.",
                metadata: {} as Metadata,
              }
            }
            return {
              title: "submit_result validation failed",
              output: `Validation failed: ${result.error}. Please correct the payload and call submit_result again.`,
              metadata: {} as Metadata,
            }
          }
          yield* storeOpt.value.setCapturedOutput(ctx.sessionID, payload).pipe(Effect.orDie)
          return {
            title: "Structured output submitted",
            output: "submit_result succeeded. Your structured output has been captured.",
            metadata: { captured: true } as Metadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
