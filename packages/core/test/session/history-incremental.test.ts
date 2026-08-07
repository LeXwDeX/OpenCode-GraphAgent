import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, DateTime, Schema } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(Database.defaultLayer)

const projectID = ProjectV2.ID.global
const sessionID = SessionSchema.ID.create()
const created = DateTime.makeUnsafe(0)
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)

const user = (text: string) =>
  SessionMessage.User.make({ id: id(text), type: "user", text, time: { created } })

const system = (text: string) =>
  SessionMessage.System.make({ id: id(text), type: "system", text, time: { created } })

const assistant = (text: string) =>
  SessionMessage.Assistant.make({
    id: id(text),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content: [SessionMessage.AssistantText.make({ type: "text", id: id(`${text}-part`), text })],
    time: { created, completed: created },
  })

const compaction = (summary: string) =>
  SessionMessage.Compaction.make({
    id: id(`compaction-${summary}`),
    type: "compaction",
    reason: "auto",
    summary,
    recent: summary,
    time: { created },
  })

const setup = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({
        id: projectID,
        worktree: AbsolutePath.make("/project"),
        sandboxes: [AbsolutePath.make("/project")],
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: sessionID,
        directory: "/project",
        title: "history",
        version: "1",
      })
      .run()
      .pipe(Effect.orDie)
  })

const insertMessage = (db: Database.Interface["db"], seq: number, message: SessionMessage.Message) => {
  const { id: messageID, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(messageID),
      session_id: sessionID,
      type,
      seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

describe("SessionHistory.entriesAfter", () => {
  it.effect("returns only messages written after the cursor", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* setup(db)
      yield* insertMessage(db, 1, user("one"))
      yield* insertMessage(db, 2, assistant("two"))
      yield* insertMessage(db, 3, user("three"))

      const empty = yield* SessionHistory.entriesAfter(db, sessionID, 0, 3)
      expect(empty.reset).toBe(false)
      expect(empty.entries).toEqual([])
      expect(empty.lastSeq).toBe(3)

      yield* insertMessage(db, 4, user("four"))
      const one = yield* SessionHistory.entriesAfter(db, sessionID, 0, 3)
      expect(one.reset).toBe(false)
      expect(one.entries.map((entry) => entry.seq)).toEqual([4])
      expect(one.entries[0]?.message.type).toBe("user")
      expect(one.lastSeq).toBe(4)

      yield* insertMessage(db, 5, assistant("five"))
      yield* insertMessage(db, 6, user("six"))
      const two = yield* SessionHistory.entriesAfter(db, sessionID, 0, 4)
      expect(two.reset).toBe(false)
      expect(two.entries.map((entry) => entry.seq)).toEqual([5, 6])
      expect(two.lastSeq).toBe(6)
    }),
  )

  it.effect("is equivalent to a full read when the cursor is advanced incrementally", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* setup(db)
      yield* insertMessage(db, 1, user("one"))
      yield* insertMessage(db, 2, assistant("two"))
      yield* insertMessage(db, 3, user("three"))
      yield* insertMessage(db, 4, system("context"))
      yield* insertMessage(db, 5, assistant("five"))
      const baseline = 3

      const first = yield* SessionHistory.entriesForRunner(db, sessionID, baseline)
      let entries = first
      let lastSeq = first.length === 0 ? 0 : first[first.length - 1]!.seq

      yield* insertMessage(db, 6, assistant("six"))
      yield* insertMessage(db, 7, user("seven"))
      let result = yield* SessionHistory.entriesAfter(db, sessionID, baseline, lastSeq)
      expect(result.reset).toBe(false)
      entries = [...entries, ...result.entries]
      lastSeq = result.lastSeq
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
      expect(entries).toEqual(yield* SessionHistory.entriesForRunner(db, sessionID, baseline))

      yield* insertMessage(db, 8, system("new-context"))
      yield* insertMessage(db, 9, user("nine"))
      result = yield* SessionHistory.entriesAfter(db, sessionID, baseline, lastSeq)
      expect(result.reset).toBe(false)
      entries = [...entries, ...result.entries]
      lastSeq = result.lastSeq
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(entries).toEqual(yield* SessionHistory.entriesForRunner(db, sessionID, baseline))
      expect(lastSeq).toBe(9)
    }),
  )

  it.effect("signals reset and returns the full read when a compaction crosses the cursor", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* setup(db)
      yield* insertMessage(db, 1, user("one"))
      yield* insertMessage(db, 2, user("two"))
      yield* insertMessage(db, 3, assistant("three"))

      const first = yield* SessionHistory.entriesForRunner(db, sessionID, 0)
      expect(first.map((entry) => entry.seq)).toEqual([1, 2, 3])

      yield* insertMessage(db, 4, compaction("summary"))
      yield* insertMessage(db, 5, user("five"))
      const result = yield* SessionHistory.entriesAfter(db, sessionID, 0, 3)
      expect(result.reset).toBe(true)
      expect(result.entries.map((entry) => entry.seq)).toEqual([4, 5])
      expect(result.entries[0]?.message.type).toBe("compaction")
      expect(result.lastSeq).toBe(5)
      expect(result.entries).toEqual(yield* SessionHistory.entriesForRunner(db, sessionID, 0))

      const settled = yield* SessionHistory.entriesAfter(db, sessionID, 0, result.lastSeq)
      expect(settled.reset).toBe(false)
      expect(settled.entries).toEqual([])

      yield* insertMessage(db, 6, user("six"))
      const next = yield* SessionHistory.entriesAfter(db, sessionID, 0, 5)
      expect(next.reset).toBe(false)
      expect(next.entries.map((entry) => entry.seq)).toEqual([6])
      expect(next.entries).toEqual((yield* SessionHistory.entriesForRunner(db, sessionID, 0)).slice(2))
    }),
  )

  it.effect("keeps the epoch baseline filter on the incremental path", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* setup(db)
      yield* insertMessage(db, 1, system("stale-context"))
      yield* insertMessage(db, 2, user("two"))
      yield* insertMessage(db, 3, system("current-context"))
      yield* insertMessage(db, 4, assistant("four"))
      const baseline = 3

      const full = yield* SessionHistory.entriesForRunner(db, sessionID, baseline)
      expect(full.map((entry) => entry.seq)).toEqual([2, 4])

      const cached = full.filter((entry) => entry.seq <= 2)
      const result = yield* SessionHistory.entriesAfter(db, sessionID, baseline, 2)
      expect(result.reset).toBe(false)
      expect(result.entries.map((entry) => entry.seq)).toEqual([4])
      expect([...cached, ...result.entries].map((entry) => entry.seq)).toEqual([2, 4])

      yield* insertMessage(db, 5, system("new-context"))
      const next = yield* SessionHistory.entriesAfter(db, sessionID, baseline, 4)
      expect(next.reset).toBe(false)
      expect(next.entries.map((entry) => entry.seq)).toEqual([5])
      expect(next.entries.map((entry) => entry.message.type)).toEqual(["system"])
      expect([...cached, ...result.entries, ...next.entries].map((entry) => entry.seq)).toEqual([2, 4, 5])
      expect([...cached, ...result.entries, ...next.entries]).toEqual(
        yield* SessionHistory.entriesForRunner(db, sessionID, baseline),
      )
    }),
  )

  it.effect("fails with MessageDecodeError on an undecodable row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* setup(db)
      yield* insertMessage(db, 1, user("one"))
      yield* db
        .insert(SessionMessageTable)
        .values({ id: id("corrupt"), session_id: sessionID, type: "user", seq: 2, data: {} as never })
        .run()
        .pipe(Effect.orDie)

      const error = yield* SessionHistory.entriesAfter(db, sessionID, 0, 0).pipe(Effect.flip)
      expect(error._tag).toBe("Session.MessageDecodeError")
      expect(error.messageID).toBe(id("corrupt"))
      expect(error.sessionID).toBe(sessionID)
    }),
  )
})
