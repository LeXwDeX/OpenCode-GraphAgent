import { and, asc, desc, eq, gt, gte, ne, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)

export const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq?: number,
  afterSeq?: number,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction
          ? or(
              gte(SessionMessageTable.seq, compaction.seq),
              baselineSeq === undefined
                ? undefined
                : and(eq(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
            )
          : undefined,
        baselineSeq === undefined
          ? undefined
          : or(ne(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
        afterSeq === undefined ? undefined : gt(SessionMessageTable.seq, afterSeq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
})

const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

const decodeEntries = (rows: typeof SessionMessageTable.$inferSelect[]) =>
  Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const [epoch, compaction] = yield* Effect.all(
    [
      db
        .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
      latestCompaction(db, sessionID),
    ],
    { concurrency: "unbounded" },
  )
  const entries = yield* decodeEntries(yield* messageRows(db, sessionID, compaction, epoch?.baselineSeq))
  return entries.map((entry) => entry.message)
})

export const loadForRunner = Effect.fn("SessionHistory.loadForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return (yield* entriesForRunner(db, sessionID, baselineSeq)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  const rows = yield* messageRows(db, sessionID, yield* latestCompaction(db, sessionID), baselineSeq)
  return yield* decodeEntries(rows)
})

/**
 * Incremental read for the runner hot path: returns only entries with
 * `seq > afterSeq` (the caller's last-read cursor), so a session of length N
 * costs O(new messages) per turn instead of a full O(N) scan.
 *
 * - `entries` are subject to the same compaction and epoch-baseline filters as
 *   `entriesForRunner`, so appending them to the caller's cached entries is
 *   equivalent to a fresh full read.
 * - `lastSeq` is the highest `seq` returned (unchanged when nothing new was
 *   written) and doubles as the next `afterSeq`.
 * - `reset` is true when a compaction has crossed the cursor since the last
 *   read. Compaction changes the read window (`seq >= compaction.seq`), so the
 *   caller must discard its cached entries and replace them with `entries`,
 *   which already contain the full read in that case.
 *
 * Epoch-baseline changes are reported by the caller (it owns the epoch) and
 * are not detected here.
 */
export const entriesAfter = Effect.fn("SessionHistory.entriesAfter")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
  afterSeq: number,
) {
  const compaction = yield* latestCompaction(db, sessionID)
  const reset = compaction !== undefined && compaction.seq > afterSeq
  const rows = yield* messageRows(db, sessionID, compaction, baselineSeq, reset ? undefined : afterSeq)
  const entries = yield* decodeEntries(rows)
  const lastSeq = entries.length === 0 ? afterSeq : entries[entries.length - 1].seq
  return { entries, lastSeq, reset }
})

export * as SessionHistory from "./history"
