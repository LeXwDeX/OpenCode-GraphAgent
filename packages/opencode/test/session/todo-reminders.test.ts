// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- fixtures
// mirror dag-wake-integration.test.ts: message/part fixtures use `as never`
// shims implementing only the slice the scenario exercises. Type-only.
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Issue #389 — per-step todo stale-state reminder.
 *
 * While a session holds uncompleted todos, every model step (including
 * tool-free steps) re-surfaces the current list as ONE synthetic part on the
 * last user message — model-visible, never persisted. Skip conditions:
 *   - no todos for the session
 *   - nothing uncompleted (completed and cancelled both count as settled)
 *   - freshness guard: the current turn's last assistant message already
 *     contains a successful todowrite call (the model just updated the list)
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionID, PartID, MessageID } from "@/session/schema"
import { Todo } from "@/session/todo"
import { TodoReminders } from "@/session/todo-reminders"
import { testEffect } from "../lib/effect"

const runtime = testEffect(Layer.empty)

function makeTodoLayer(todos: Todo.Info[]) {
  return Layer.mock(Todo.Service, {
    get: () => Effect.succeed(todos),
  })
}

let clock = 0

function userMessage(text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "user",
      sessionID: SessionID.make("ses_1"),
      time: { created: clock++ },
      agent: "build",
      model: { providerID: "test" as never, modelID: "m" as never },
    },
    parts: [{
      id: PartID.ascending(),
      messageID: id,
      sessionID: SessionID.make("ses_1"),
      type: "text",
      text,
    }] as never,
  }
}

function assistantMessage(
  tools: { name: string; status: string }[] = [],
  text?: string,
): SessionV1.WithParts {
  const id = MessageID.ascending()
  const parts: Record<string, unknown>[] = tools.map((t) => ({
    id: PartID.ascending(),
    messageID: id,
    sessionID: SessionID.make("ses_1"),
    type: "tool",
    callID: `call-${clock++}`,
    tool: t.name,
    state: {
      status: t.status,
      input: {},
      ...(t.status === "completed" ? { output: "", title: "" } : t.status === "error" ? { error: "boom" } : {}),
    },
  }))
  if (text) {
    parts.push({
      id: PartID.ascending(),
      messageID: id,
      sessionID: SessionID.make("ses_1"),
      type: "text",
      text,
    })
  }
  return {
    info: {
      id,
      role: "assistant",
      sessionID: SessionID.make("ses_1"),
      parentID: MessageID.ascending(),
      time: { created: clock++ },
      mode: "build",
      agent: "build",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "m" as never,
      providerID: "test" as never,
      path: { cwd: "/tmp", root: "/tmp" },
      finish: "stop",
    },
    parts: parts as never,
  }
}

function lastUser(messages: SessionV1.WithParts[]) {
  return messages.findLast((m) => m.info.role === "user")
}

describe("TodoReminders.apply (issue #389)", () => {
  runtime.effect("injects nothing when the session has no todos", () =>
    Effect.gen(function* () {
      const messages = [userMessage("work")]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(Effect.provide(makeTodoLayer([])))
      expect(result).toBe(messages)
      expect(lastUser(result)?.parts).toHaveLength(1)
    }),
  )

  runtime.effect("injects nothing when every todo is settled (completed or cancelled)", () =>
    Effect.gen(function* () {
      const messages = [userMessage("work")]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(
        Effect.provide(makeTodoLayer([
          { content: "a", status: "completed", priority: "high" },
          { content: "b", status: "cancelled", priority: "low" },
        ])),
      )
      expect(lastUser(result)?.parts).toHaveLength(1)
    }),
  )

  runtime.effect("injects exactly one synthetic reminder with uncompleted statuses", () =>
    Effect.gen(function* () {
      const messages = [userMessage("work")]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(
        Effect.provide(makeTodoLayer([
          { content: "implement reminder module", status: "in_progress", priority: "high" },
          { content: "add tests", status: "pending", priority: "high" },
          { content: "shipped", status: "completed", priority: "low" },
        ])),
      )
      const last = lastUser(result)
      expect(last?.parts).toHaveLength(2)
      const reminder = last?.parts.at(-1) as never as { type: string; text: string; synthetic?: boolean }
      expect(reminder.type).toBe("text")
      expect(reminder.synthetic).toBe(true)
      expect(reminder.text).toContain("implement reminder module")
      expect(reminder.text).toContain("in_progress")
      expect(reminder.text).toContain("add tests")
      expect(reminder.text).toContain("pending")
      expect(reminder.text).not.toContain("shipped")
      expect(reminder.text).toContain("todowrite")
    }),
  )

  runtime.effect("freshness guard: skips when the turn's last assistant message contains a successful todowrite", () =>
    Effect.gen(function* () {
      const messages = [
        userMessage("work"),
        assistantMessage([{ name: "todowrite", status: "completed" }], "updated"),
      ]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(
        Effect.provide(makeTodoLayer([
          { content: "a", status: "pending", priority: "high" },
        ])),
      )
      expect(lastUser(result)?.parts).toHaveLength(1)
    }),
  )

  runtime.effect("an older todowrite does not suppress the reminder once further steps followed", () =>
    Effect.gen(function* () {
      const messages = [
        userMessage("work"),
        assistantMessage([{ name: "todowrite", status: "completed" }]),
        assistantMessage([{ name: "read", status: "completed" }], "read the file"),
      ]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(
        Effect.provide(makeTodoLayer([
          { content: "a", status: "pending", priority: "high" },
        ])),
      )
      expect(lastUser(result)?.parts).toHaveLength(2)
    }),
  )

  runtime.effect("a failed todowrite does not satisfy the freshness guard", () =>
    Effect.gen(function* () {
      const messages = [
        userMessage("work"),
        assistantMessage([{ name: "todowrite", status: "error" }]),
      ]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(
        Effect.provide(makeTodoLayer([
          { content: "a", status: "pending", priority: "high" },
        ])),
      )
      expect(lastUser(result)?.parts).toHaveLength(2)
    }),
  )
})
