import * as Tool from "./tool"
import DESCRIPTION from "./submit_result.txt"
import { Effect, Option, Schema } from "effect"
import { validatePayload, getCaptureSnapshot } from "@/dag/runtime/capture"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { InstanceState } from "@/effect/instance-state"

const id = "submit_result"
const parseJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export const Parameters = Schema.Struct({
  payload: Schema.Unknown.annotate({
    description:
      "JSON value matching the node's declared output_schema (object, array, string, number, boolean, or null).",
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
                output:
                  "submit_result has no effect in this session — it is only for DAG workflow child sessions that declared an output_schema.",
                metadata: {} as Metadata,
              }
            }
            return {
              title: "submit_result validation failed",
              output: `Validation failed: ${result.error}. Please correct the payload and call submit_result again.`,
              metadata: {} as Metadata,
            }
          }
          let snapshotID = getCaptureSnapshot(ctx.sessionID)
          const messages = yield* Effect.serviceOption(DagMessages.Service)
          const commit = () => storeOpt.value.setCapturedOutput(ctx.sessionID, payload, snapshotID).pipe(Effect.orDie)
          if (Option.isSome(messages)) {
            const instance = yield* InstanceState.context
            const caller = { projectID: instance.project.id, directory: instance.directory, sessionID: ctx.sessionID }
            const identity = yield* messages.value.revisions(caller)
            if (!identity.ok || identity.value.endpoint.kind !== "node")
              return {
                title: "submit_result not applicable",
                output: "This session is not a current DAG node attempt.",
                metadata: {},
              }
            const snapshot = yield* messages.value.snapshotForTurn(caller, ctx.messageID)
            if (!snapshot.ok || !snapshot.value)
              return {
                title: "submit_result input unavailable",
                output:
                  "This tool call has no recorded input snapshot. Consume current agent input before submitting a result.",
                metadata: {},
              }
            snapshotID = snapshot.value.id
            const endpoint = identity.value.endpoint
            const result = yield* messages.value.guard(
              caller,
              {
                workflowID: endpoint.workflowID!,
                nodeID: endpoint.nodeID!,
                attemptID: endpoint.attemptID!,
                snapshotID,
                close: false,
              },
              commit(),
            )
            if (!result.ok)
              return {
                title: "submit_result input changed",
                output: `Submission was not captured (${result.reason}). Consume the current agent input before submitting an updated result. Previously completed tools remain recorded; do not repeat their writes.`,
                metadata: {},
              }
          } else yield* commit()
          return {
            title: "Structured output submitted",
            output: "submit_result succeeded. Your structured output has been captured.",
            metadata: { captured: true } as Metadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
