import { Cause, DateTime, Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { and, eq, gt } from "drizzle-orm"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionMessageTable, SessionTable } from "../sql"
import { adoptionProvenance, type ReasoningReplacement } from "./adoption"
import { replaceCanonicalReasoning } from "./canonical"

/**
 * Commit one accepted rewrite of a settled reasoning part. Validation runs inside the event transaction: the job must
 * still be adoptable (not sealed by a send barrier, feature enabled), the session must not be reverted, and the
 * persisted part must be exactly the source that was organized. Later user messages do not block adoption, but a later
 * assistant attempt does: the in-process send barrier covers this process, and that durable fence covers others.
 */
export const adoptReasoning = Effect.fn("CoreReasoningDistillation.adopt")(function* (input: {
  events: EventV2.Interface
  db: Database.Interface["db"]
  sessionID: SessionSchema.ID
  messageID: SessionMessage.ID
  part: SessionMessage.AssistantReasoning
  replacement: ReasoningReplacement
  canAdopt: Effect.Effect<boolean>
}) {
  const { part, replacement } = input
  if (
    replacement.messageID !== input.messageID ||
    replacement.partID !== part.id ||
    part.distillation ||
    part.text !== replacement.before ||
    replacement.after === replacement.before
  )
    return false
  const source = { text: part.text, metadata: part.providerMetadata, settled: true, distilled: false }
  const edited = replaceCanonicalReasoning(source, replacement.after)
  if (!edited) return false
  const validate = Effect.gen(function* () {
    if (!(yield* input.canAdopt)) yield* Effect.die("reasoning rewrite was sealed or disabled")
    const session = yield* input.db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!session || session.revert) yield* Effect.die("reasoning source was reverted")
    const row = yield* input.db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, input.messageID))
      .get()
      .pipe(Effect.orDie)
    const message = row
      ? yield* Schema.decodeUnknownEffect(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }).pipe(
          Effect.orDie,
        )
      : undefined
    const current = message?.type === "assistant" ? message.content.filter((item) => item.id === part.id) : []
    if (!row || row.session_id !== input.sessionID || current.length !== 1 || !isDeepStrictEqual(current[0], part))
      return yield* Effect.die("stale reasoning adoption")
    // Durable send fence: the in-memory barrier only covers this process. Once any process has persisted a later
    // assistant attempt, that request may already carry the original, so the part is never rewritten afterwards.
    const later = yield* input.db
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, input.sessionID),
          eq(SessionMessageTable.type, "assistant"),
          gt(SessionMessageTable.seq, row.seq),
        ),
      )
      .limit(1)
      .all()
      .pipe(Effect.orDie)
    if (later.length > 0) yield* Effect.die("reasoning was already resent by a later attempt")
  })
  return yield* input.events
    .publishMany(
      [
        {
          definition: SessionEvent.Reasoning.Ended,
          data: {
            sessionID: input.sessionID,
            assistantMessageID: input.messageID,
            reasoningID: part.id,
            text: edited.text,
            providerMetadata: edited.metadata,
            distillation: adoptionProvenance(source),
            timestamp: DateTime.makeUnsafe(Date.now()),
          },
        },
      ],
      { validate },
    )
    .pipe(
      Effect.as(true),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.logInfo("reasoning adoption rejected; retaining current history").pipe(Effect.as(false)),
      ),
    )
})
