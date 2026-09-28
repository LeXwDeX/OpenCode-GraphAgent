import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { EventTable } from "../../src/event/sql"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { ModelV2 } from "../../src/model"
import { ProviderV2 } from "../../src/provider"
import { SessionSchema } from "../../src/session/schema"
import { SessionMessage } from "../../src/session/message"
import { SessionProjector } from "../../src/session/projector"
import { SessionStore } from "../../src/session/store"
import { SessionMessageTable, SessionTable } from "../../src/session/sql"
import { adoptReasoning } from "../../src/session/reasoning-distillation/adopt"
import { reasoningReplacements } from "../../src/session/reasoning-distillation/adoption"
import { toLLMMessagesWithBindings } from "../../src/session/runner/to-llm-message"
import { Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(Database.defaultLayer, EventV2.defaultLayer, SessionProjector.defaultLayer, SessionStore.defaultLayer),
)
const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })

const seed = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const store = yield* SessionStore.Service
  const sessionID = SessionSchema.ID.make("ses_adoption")
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "adoption",
      directory: "/project",
      title: "adoption",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  const message: SessionMessage.Assistant = {
    id: SessionMessage.ID.make("msg_adoption"),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    content: [
      { type: "reasoning", id: "r1", text: "first original" },
      { type: "text", id: "t1", text: "answer unchanged" },
      { type: "reasoning", id: "r2", text: "second original" },
    ],
  }
  const { id: _id, type, ...data } = Schema.encodeSync(SessionMessage.Assistant)(message)
  yield* db
    .insert(SessionMessageTable)
    .values({ id: message.id, type, data, session_id: sessionID, seq: 0, time_created: 1 })
    .run()
    .pipe(Effect.orDie)
  const replacements = [
    { messageID: message.id, partID: "r1", before: "first original", after: "first adopted" },
    { messageID: message.id, partID: "r2", before: "second original", after: "second adopted" },
  ]
  return { db, events, store, sessionID, message, replacements }
})

describe("durable reasoning adoption", () => {
  it.effect("persists all accepted slots and reloads the same text into model context without provenance leakage", () =>
    Effect.gen(function* () {
      const { db, events, store, sessionID, message, replacements } = yield* seed()
      expect(yield* adoptReasoning(events, db, sessionID, [message], replacements)).toBe(true)
      const stored = yield* store.message(message.id)
      expect(stored?.message).toMatchObject({
        content: [
          { type: "reasoning", id: "r1", text: "first adopted", distillation: { originalText: "first original" } },
          { type: "text", id: "t1", text: "answer unchanged" },
          { type: "reasoning", id: "r2", text: "second adopted", distillation: { originalText: "second original" } },
        ],
      })
      if (!stored) throw new Error("missing stored message")
      const conversion = toLLMMessagesWithBindings([stored.message], model)
      expect(conversion.reasoningBindings.every((part) => part.distilled)).toBe(true)
      expect(JSON.stringify(conversion.messages)).not.toContain("original")
      expect(JSON.stringify(conversion.messages)).toContain("first adopted")
      const switched = toLLMMessagesWithBindings(
        [stored.message],
        Model.make({ id: "other", provider: model.provider, route: model.route }),
      )
      expect(JSON.stringify(switched.messages)).toContain("first adopted")
      expect(JSON.stringify(switched.messages)).not.toContain("original")
      expect(yield* adoptReasoning(events, db, sessionID, [stored.message], replacements)).toBe(false)
    }),
  )

  it.effect("rejects the entire batch before emitting events when any persisted source has changed", () =>
    Effect.gen(function* () {
      const { db, events, store, sessionID, message, replacements } = yield* seed()
      const changed = {
        ...message,
        content: message.content.map((part) => (part.id === "r2" ? { ...part, text: "newer second" } : part)),
      }
      const { id: _id, type: _type, ...data } = Schema.encodeSync(SessionMessage.Assistant)(changed)
      yield* db
        .update(SessionMessageTable)
        .set({ data })
        .where(eq(SessionMessageTable.id, message.id))
        .run()
        .pipe(Effect.orDie)
      expect(yield* adoptReasoning(events, db, sessionID, [message], replacements)).toBe(false)
      expect((yield* store.message(message.id))?.message).toEqual(changed)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("extracts every changed wire slot rather than only the last cycle plan", () =>
    Effect.sync(() => {
      expect(
        reasoningReplacements({ messages: [{ reasoning: "first adopted" }, { reasoning: "second adopted" }] }, [
          { messageID: "m1", partID: "r1", text: "first original", bodyPath: ["messages", 0, "reasoning"] },
          { messageID: "m2", partID: "r2", text: "second original", bodyPath: ["messages", 1, "reasoning"] },
        ]),
      ).toEqual([
        { messageID: "m1", partID: "r1", before: "first original", after: "first adopted" },
        { messageID: "m2", partID: "r2", before: "second original", after: "second adopted" },
      ])
    }),
  )
  it.effect("checks the switch again inside the adoption transaction", () =>
    Effect.gen(function* () {
      const { db, events, store, sessionID, message, replacements } = yield* seed()
      expect(yield* adoptReasoning(events, db, sessionID, [message], replacements, Effect.succeed(false))).toBe(false)
      expect((yield* store.message(message.id))?.message).toEqual(message)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )
})
