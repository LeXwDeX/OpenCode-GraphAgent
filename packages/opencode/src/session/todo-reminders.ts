// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-step todo stale-state reminder (issue #389).
 *
 * Todo lists drift silently: nothing re-surfaces the list once written, so
 * completed work stays pending and stale items linger. While a session holds
 * uncompleted todos, every model step appends ONE synthetic text part with the
 * current uncompleted items to the last user message — model-visible, never
 * persisted (same in-memory convention as SessionReminders' non-plan-mode
 * parts; its plan-mode branch persists instead, which is NOT the pattern
 * here).
 *
 * Skip conditions:
 *   - no todos for the session, or nothing uncompleted (completed and
 *     cancelled both count as settled)
 *   - freshness guard: the session's last assistant message already contains
 *     a successful todowrite call — the model just updated the list itself,
 *     so this step's request does not nag about it
 *
 * Second surfacing point (#429): before a non-todowrite tool call executes,
 * the current uncompleted list is returned once per assistant turn so long
 * multi-tool turns re-see it mid-flight. Turn-scoped dedup keeps parallel
 * tool calls from repeating the same reminder N times — the original reason
 * #389 refined this seam away; pure-reasoning steps stay covered by the
 * per-step injection above.
 */
import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionID } from "./schema"
import { PartID } from "./schema"
import { Todo } from "./todo"

const TODO_WRITE_TOOL = "todowrite"

// sessionID -> assistant messageID that already received the pre-tool-call
// reminder this turn. One entry per live session, overwritten each turn.
const remindedTurns = new Map<string, string>()

function uncompletedOf(todos: Todo.Info[]): Todo.Info[] {
  return todos.filter((item) => item.status !== "completed" && item.status !== "cancelled")
}

function turnJustUpdatedTodos(messages: SessionV1.WithParts[]): boolean {
  const lastAssistant = messages.findLast((msg) => msg.info.role === "assistant")
  if (!lastAssistant) return false
  return lastAssistant.parts.some(
    (part): part is SessionV1.ToolPart =>
      part.type === "tool" && part.tool === TODO_WRITE_TOOL && part.state.status === "completed",
  )
}

function renderReminder(uncompleted: Todo.Info[]): string {
  const lines = uncompleted.map((todo) => `- ${todo.status}: ${todo.content}`)
  return [
    `[todo reminder] ${uncompleted.length} uncompleted todo item${uncompleted.length === 1 ? "" : "s"}:`,
    ...lines,
    "Keep the list current: mark items completed when done, adjust stale entries, and set in_progress only for the item you are actively working on. Update via todowrite.",
  ].join("\n")
}

export const apply = Effect.fn("TodoReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  sessionID: SessionID
}) {
  const todo = yield* Todo.Service
  const todos = yield* todo.get(input.sessionID)
  const uncompleted = uncompletedOf(todos)
  if (uncompleted.length === 0) return input.messages
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages
  if (turnJustUpdatedTodos(input.messages)) return input.messages
  userMessage.parts.push({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: input.sessionID,
    type: "text",
    text: renderReminder(uncompleted),
    synthetic: true,
  } satisfies SessionV1.TextPart)
  return input.messages
})

/**
 * Reminder string for the pre-tool-call seam, or undefined when the call must
 * stay clean: todowrite itself, a turn already surfaced this turn, or nothing
 * uncompleted. Marks the turn only when a string is actually returned.
 */
export const preToolCall = Effect.fn("TodoReminders.preToolCall")(function* (input: {
  sessionID: SessionID
  messageID: string
  tool: string
}) {
  if (input.tool === TODO_WRITE_TOOL) return undefined
  if (remindedTurns.get(input.sessionID) === input.messageID) return undefined
  const todo = yield* Todo.Service
  const todos = yield* todo.get(input.sessionID)
  const uncompleted = uncompletedOf(todos)
  if (uncompleted.length === 0) return undefined
  remindedTurns.set(input.sessionID, input.messageID)
  return renderReminder(uncompleted)
})

export * as TodoReminders from "./todo-reminders"
