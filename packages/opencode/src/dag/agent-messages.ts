// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { DagStore } from "@opencode-ai/core/dag/store"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

export interface ObserveInput {
  sessionID: string
  workflow_id: string
  node_id?: string
  attempt_id?: string
  limit?: number
  cursor?: string
}
export interface SendInput {
  sessionID: string
  workflow_id: string
  recipient: "node" | "parent"
  node_id?: string
  attempt_id?: string
  idempotency_key: string
  content: string
  reply_to?: string
}
export interface ReceiveInput {
  sessionID: string
  workflow_id?: string
  after_sequence?: number
  limit?: number
  wait_ms?: number
  signal?: AbortSignal
}
export interface Interface {
  observe: (input: ObserveInput) => Effect.Effect<unknown>
  send: (input: SendInput) => Effect.Effect<unknown>
  receive: (input: ReceiveInput) => Effect.Effect<unknown>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/DagAgentMessages") {}

class ObservationCursor extends Schema.Class<ObservationCursor>("AgentObservationCursor")({
  workflowID: Schema.String,
  nodeID: Schema.optional(Schema.String),
  attemptID: Schema.optional(Schema.String),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}
const CursorJSON = Schema.fromJsonString(ObservationCursor)
const parseCursor = Schema.decodeUnknownResult(CursorJSON)
const maxPreview = 2_000
const preview = (value: unknown) => {
  if (value === undefined) return undefined
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return { text: text.slice(0, maxPreview), truncated: text.length > maxPreview }
}
const wireMessage = (message: DagMessages.Message) => ({
  message_id: message.id,
  workflow_id: message.workflowID,
  sender: message.sender,
  recipient: message.recipient,
  recipient_sequence: message.recipientSequence,
  accepted_revision: message.acceptedRevision,
  content: message.content,
  reply_to: message.replyTo,
  state: message.state,
  reason: message.reason,
  snapshot_id: message.snapshotID,
  time_created: message.timeCreated,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const messages = yield* DagMessages.Service
    const store = yield* DagStore.Service
    const sessions = yield* Session.Service
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const disposed = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(disposed, undefined))
        return { disposed }
      }),
    )
    const caller = (sessionID: string) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        return { projectID: instance.project.id, directory: instance.directory, sessionID }
      })

    return Service.of({
      observe: Effect.fn("DagAgentMessages.observe")(function* (input) {
        const identity = yield* caller(input.sessionID)
        if (input.attempt_id && !input.node_id) return { ok: false, reason: "invalid" }
        const permission = yield* messages.resolve(identity, input.workflow_id)
        if (!permission.ok) return permission
        const workflow = yield* store.getWorkflow(input.workflow_id)
        if (!workflow) return { ok: false, reason: "unauthorized" }
        // Only the owner observes the graph; a node can inspect its own attempt.
        if (workflow.sessionId !== input.sessionID) {
          const self = (yield* store.getNodes(input.workflow_id)).find((row) => row.childSessionId === input.sessionID)
          if (!self || input.node_id !== self.id) return { ok: false, reason: "unauthorized" }
        }
        let offset = 0
        if (input.cursor !== undefined) {
          const parsed = parseCursor(input.cursor)
          if (
            parsed._tag === "Failure" ||
            parsed.success.workflowID !== input.workflow_id ||
            parsed.success.nodeID !== input.node_id ||
            parsed.success.attemptID !== input.attempt_id
          ) {
            return { ok: false, reason: "invalid_cursor" }
          }
          offset = parsed.success.offset
        }
        const limit = input.limit ?? 20
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return { ok: false, reason: "invalid" }
        const all = (yield* store.getNodes(input.workflow_id))
          .filter((row) => !input.node_id || row.id === input.node_id)
          .toSorted((a, b) => a.id.localeCompare(b.id))
        let authorityLost = false
        const nodes = yield* Effect.forEach(all.slice(offset, offset + limit), (row) =>
          Effect.gen(function* () {
            const observedAttempt = row.childSessionId
              ? DagMessages.nodeAttemptID(row.childSessionId, row.replanAttempts)
              : undefined
            const revisions = yield* messages.metadata(
              identity,
              input.workflow_id,
              row.id,
              input.attempt_id ?? observedAttempt,
            )
            if (!revisions.ok && revisions.reason === "unauthorized") {
              authorityLost = true
              return undefined
            }
            if (input.attempt_id && !revisions.ok) return undefined
            // An authorization or attempt race cannot fall back to an unverified
            // child session from a separate projection read.
            const childSessionID = revisions.ok ? revisions.value.endpoint.sessionID : undefined
            const historical = row.superseded || (!!input.attempt_id && input.attempt_id !== observedAttempt)
            const transcript = childSessionID
              ? yield* sessions
                  .messages({ sessionID: SessionID.make(childSessionID), limit: 3 })
                  .pipe(Effect.catch(() => Effect.succeed([])))
              : []
            const tools = transcript
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
              .slice(-10)
              .map((part) => ({ tool: part.tool, status: part.state.status }))
            const progress = transcript
              .toSorted((a, b) => a.info.time.created - b.info.time.created)
              .flatMap((message) => (message.info.role === "assistant" ? message.parts : []))
              .flatMap((part) => (part.type === "text" && !part.synthetic ? [part] : []))
              .slice(-1)
              .map((part) => preview(part.text))[0]
            return {
              node_id: row.id,
              name: row.name,
              status: historical
                ? revisions.ok
                  ? (revisions.value.closedReason ?? "historical")
                  : "historical"
                : row.status,
              historical,
              attempt_id: revisions.ok ? revisions.value.endpoint.attemptID : undefined,
              accepted_input_revision: revisions?.ok ? revisions.value.accepted : 0,
              snapshot_revision: revisions?.ok ? revisions.value.snapshot : 0,
              message_counts: revisions?.ok
                ? {
                    queued: revisions.value.queued,
                    delivered: revisions.value.delivered,
                    undeliverable: revisions.value.undeliverable,
                  }
                : { queued: 0, delivered: 0, undeliverable: 0 },
              projection_sequence: row.seq,
              closed_reason: revisions.ok ? revisions.value.closedReason : undefined,
              progress,
              output:
                !historical && (row.status === "completed" || row.output !== null) ? preview(row.output) : undefined,
              tools,
            }
          }),
        )
        if (authorityLost) return { ok: false, reason: "unauthorized" }
        return {
          ok: true,
          workflow_id: workflow.id,
          status: workflow.status,
          graph_rev: workflow.graphRev,
          projection_sequence: workflow.seq,
          observed_at: Date.now(),
          freshness: "durable_reads_nonatomic",
          nodes: nodes.filter((node) => node !== undefined),
          next_cursor:
            offset + limit < all.length
              ? JSON.stringify({
                  workflowID: input.workflow_id,
                  nodeID: input.node_id,
                  attemptID: input.attempt_id,
                  offset: offset + limit,
                })
              : undefined,
        }
      }),
      send: Effect.fn("DagAgentMessages.send")(function* (input) {
        const result = yield* messages.send(yield* caller(input.sessionID), {
          workflowID: input.workflow_id,
          nodeID: input.recipient === "node" ? input.node_id : undefined,
          attemptID: input.recipient === "node" ? input.attempt_id : undefined,
          idempotencyKey: input.idempotency_key,
          content: input.content,
          replyTo: input.reply_to,
        })
        return result.ok ? { ok: true, ...wireMessage(result.value) } : result
      }),
      receive: Effect.fn("DagAgentMessages.receive")(function* (input) {
        if (input.signal?.aborted) return yield* Effect.interrupt
        const identity = yield* caller(input.sessionID)
        const wait = input.wait_ms ?? 0
        const limit = input.limit ?? 20
        if (
          !Number.isSafeInteger(wait) ||
          wait < 0 ||
          wait > 30_000 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 50
        ) {
          return { ok: false, reason: "invalid" }
        }
        if (input.workflow_id) {
          const permission = yield* messages.resolve(identity, input.workflow_id)
          if (!permission.ok) return permission
        }
        const read = () =>
          messages.receive(identity, { workflowID: input.workflow_id, afterSequence: input.after_sequence, limit })
        const poll = Effect.gen(function* () {
          const end = Date.now() + wait
          while (true) {
            const result = yield* read()
            if (!result.ok) return result
            const received = result.value.filter(
              (message) => !input.workflow_id || message.workflowID === input.workflow_id,
            )
            if (received.length > 0 || Date.now() >= end)
              return {
                ok: true,
                messages: received.map(wireMessage),
                cursor: result.value.at(-1)?.recipientSequence ?? input.after_sequence ?? 0,
              }
            yield* Effect.sleep(Math.min(100, end - Date.now()))
          }
        })
        const disposed = (yield* InstanceState.get(state)).disposed
        const abort = Effect.callback<never>((resume) => {
          const cancel = () => resume(Effect.interrupt)
          if (input.signal?.aborted) return cancel()
          input.signal?.addEventListener("abort", cancel, { once: true })
          return Effect.sync(() => input.signal?.removeEventListener("abort", cancel))
        })
        return yield* Effect.raceFirst(
          poll,
          Effect.raceFirst(abort, Deferred.await(disposed).pipe(Effect.andThen(Effect.interrupt))),
        )
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(DagMessages.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(Session.defaultLayer),
)
export const node = LayerNode.make(layer, [DagMessages.node, DagStore.node, Session.node])
export * as DagAgentMessages from "./agent-messages"
