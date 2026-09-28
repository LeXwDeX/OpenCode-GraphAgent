import { Database } from "@opencode-ai/core/database/database"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Cause, DateTime, Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import {
  adoptionProvenance,
  type ReasoningReplacement,
} from "@opencode-ai/core/session/reasoning-distillation/adoption"
import { replaceCanonicalReasoning } from "@opencode-ai/core/session/reasoning-distillation/canonical"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "./session"
import type { SessionID } from "./schema"

/** Commit the same accepted text consumed by the outgoing request and by existing live/reload UI paths. */
export const adoptReasoning = Effect.fn("Session.adoptReasoning")(function* (input: {
  sessionID: SessionID
  sources: readonly SessionV1.WithParts[]
  replacements: readonly ReasoningReplacement[]
  canAdopt?: Effect.Effect<boolean>
}) {
  if (input.replacements.length === 0) return false
  const session = yield* Session.Service
  const events = yield* EventV2Bridge.Service
  const { db } = yield* Database.Service
  const entries: EventV2.BatchEvent[] = []
  const sources: SessionV1.ReasoningPart[] = []
  const seen = new Set<string>()
  for (const replacement of input.replacements) {
    const part = input.sources
      .find((message) => message.info.id === replacement.messageID && message.info.role === "assistant")
      ?.parts.find((part) => part.id === replacement.partID)
    if (
      !part ||
      part.type !== "reasoning" ||
      part.sessionID !== input.sessionID ||
      part.text !== replacement.before ||
      part.time.end === undefined ||
      part.distillation ||
      replacement.after === replacement.before ||
      seen.has(part.id)
    )
      return false
    const source = { text: part.text, metadata: part.metadata, settled: true, distilled: false }
    const edited = replaceCanonicalReasoning(source, replacement.after)
    if (!edited) return false
    seen.add(part.id)
    sources.push(part)
    const distillation = adoptionProvenance(source)
    entries.push({
      definition: SessionV1.Event.PartUpdated,
      data: {
        sessionID: input.sessionID,
        part: { ...part, text: edited.text, metadata: edited.metadata, distillation },
        time: Date.now(),
      },
    })
    if (part.v2)
      entries.push({
        definition: SessionEvent.Reasoning.Ended,
        data: {
          sessionID: input.sessionID,
          assistantMessageID: SessionMessage.ID.make(part.v2.messageID),
          reasoningID: part.v2.reasoningID,
          text: edited.text,
          providerMetadata: edited.metadata,
          distillation,
          timestamp: DateTime.makeUnsafe(Date.now()),
        },
      })
  }
  // Validate before any projector runs, inside the same transaction as the entire event batch.
  const validate = Effect.gen(function* () {
    if (input.canAdopt && !(yield* input.canAdopt)) yield* Effect.die("reasoning distillation was disabled")
    const currentSession = yield* session.get(input.sessionID).pipe(Effect.orDie)
    if (currentSession.revert) yield* Effect.die("reasoning source was reverted")
    const currentMessages = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
    for (const user of input.sources.filter((message) => message.info.role === "user")) {
      if (
        !isDeepStrictEqual(
          currentMessages.find((message) => message.info.id === user.info.id),
          user,
        )
      )
        yield* Effect.die("reasoning source user was changed")
    }
    const sourceIDs = new Set(input.sources.map((message) => message.info.id))
    if (currentMessages.some((message) => !sourceIDs.has(message.info.id)))
      yield* Effect.die("reasoning turn was retried or continued")
    const parentIDs = new Set(
      input.sources
        .filter(
          (message) => message.info.role === "assistant" && sources.some((part) => part.messageID === message.info.id),
        )
        .map((message) => (message.info.role === "assistant" ? message.info.parentID : undefined)),
    )
    if (
      currentMessages.some(
        (message) =>
          message.info.role === "assistant" && parentIDs.has(message.info.parentID) && !sourceIDs.has(message.info.id),
      )
    )
      yield* Effect.die("reasoning turn was retried")
    for (const source of sources) {
      const current = yield* session.getPart({
        sessionID: input.sessionID,
        messageID: source.messageID,
        partID: source.id,
      })
      if (!isDeepStrictEqual(current, source)) yield* Effect.die("stale reasoning adoption")
      if (source.v2) {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, SessionMessage.ID.make(source.v2.messageID)))
          .get()
          .pipe(Effect.orDie)
        const message = row
          ? yield* Schema.decodeUnknownEffect(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }).pipe(
              Effect.orDie,
            )
          : undefined
        const content = message?.type === "assistant" ? message.content : []
        const matches = content.filter((part) => part.id === source.v2?.reasoningID)
        if (
          row?.session_id !== input.sessionID ||
          matches.length !== 1 ||
          matches[0].type !== "reasoning" ||
          matches[0].text !== source.text ||
          matches[0].distillation ||
          !isDeepStrictEqual(matches[0].providerMetadata, source.metadata)
        )
          yield* Effect.die("stale mirrored reasoning adoption")
      }
    }
  })
  return yield* events.publishMany(entries, { validate }).pipe(
    Effect.as(true),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      () => Effect.logWarning("reasoning adoption failed; retaining current history").pipe(Effect.as(false)),
    ),
  )
})
