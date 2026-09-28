import { Cause, DateTime, Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { eq, gt, and } from "drizzle-orm"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionMessageTable, SessionTable } from "../sql"
import { adoptionProvenance, type ReasoningReplacement } from "./adoption"
import { replaceCanonicalReasoning } from "./canonical"

export const adoptReasoning = Effect.fn("CoreReasoningDistillation.adopt")(function* (
  events: EventV2.Interface,
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  messages: readonly SessionMessage.Message[],
  replacements: readonly ReasoningReplacement[],
  canAdopt: Effect.Effect<boolean> = Effect.succeed(true),
) {
  if (replacements.length === 0) return false
  const entries: EventV2.BatchEvent[] = []
  const checks: Array<{ messageID: SessionMessage.ID; part: SessionMessage.AssistantReasoning }> = []
  const seen = new Set<string>()
  for (const replacement of replacements) {
    const message = messages.find((message) => message.id === replacement.messageID)
    if (!message || message.type !== "assistant" || message.time.completed === undefined) return false
    const part = message.content.find((part) => part.id === replacement.partID)
    const key = JSON.stringify([message.id, replacement.partID])
    if (
      !part ||
      part.type !== "reasoning" ||
      part.distillation ||
      part.text !== replacement.before ||
      !replacement.after.trim() ||
      seen.has(key)
    )
      return false
    const source = { text: part.text, metadata: part.providerMetadata, settled: true, distilled: false }
    const edited = replaceCanonicalReasoning(source, replacement.after)
    if (!edited) return false
    seen.add(key)
    checks.push({ messageID: message.id, part })
    entries.push({
      definition: SessionEvent.Reasoning.Ended,
      data: {
        sessionID,
        assistantMessageID: message.id,
        reasoningID: part.id,
        text: edited.text,
        providerMetadata: edited.metadata,
        distillation: adoptionProvenance(source),
        timestamp: DateTime.makeUnsafe(Date.now()),
      },
    })
  }
  const validate = Effect.gen(function* () {
    if (!(yield* canAdopt)) yield* Effect.die("reasoning distillation was disabled")
    const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!session || session.revert) yield* Effect.die("reasoning source was reverted")
    const user = messages.findLast((message) => message.type === "user")
    if (!user) throw new Error("reasoning turn has no user")
    const userRow = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, user.id))
      .get()
      .pipe(Effect.orDie)
    if (!userRow || userRow.session_id !== sessionID) throw new Error("reasoning turn user was changed")
    const known = new Set(messages.map((message) => message.id))
    const later = yield* db
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), gt(SessionMessageTable.seq, userRow.seq)))
      .all()
      .pipe(Effect.orDie)
    if (later.some((row) => !known.has(row.id))) yield* Effect.die("reasoning turn was retried or continued")
    for (const user of messages.filter((message) => message.type === "user")) {
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, user.id))
        .get()
        .pipe(Effect.orDie)
      const current = row
        ? yield* Schema.decodeUnknownEffect(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }).pipe(
            Effect.orDie,
          )
        : undefined
      if (row?.session_id !== sessionID || !isDeepStrictEqual(current, user))
        yield* Effect.die("reasoning source user was changed")
    }
    for (const check of checks) {
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, check.messageID))
        .get()
        .pipe(Effect.orDie)
      const message = row
        ? yield* Schema.decodeUnknownEffect(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }).pipe(
            Effect.orDie,
          )
        : undefined
      const current =
        message?.type === "assistant" ? message.content.find((part) => part.id === check.part.id) : undefined
      if (row?.session_id !== sessionID || !isDeepStrictEqual(current, check.part))
        yield* Effect.die("stale reasoning adoption")
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
