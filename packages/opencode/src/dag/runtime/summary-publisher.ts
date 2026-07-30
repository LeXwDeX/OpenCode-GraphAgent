export * as DagSummaryPublisher from "./summary-publisher"

import { Effect, Layer, Scope, Context } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { DagStore } from "@opencode-ai/core/dag/store"
import { GlobalBus } from "@/bus/global"

/**
 * Stateless derived-view publisher for DAG workflow summaries.
 *
 * Subscribes to all `dag.*` events. On each event, reads the affected session's
 * workflow summaries from DagStore (the single source of truth) and emits a
 * `dag.workflow.summary.updated` event on GlobalBus carrying the full
 * `WorkflowSummary[]` payload for that session.
 *
 * Invariants (enforced by the "stateless derived view" contract):
 * - No module-level Map, Set, counter, or cached state.
 * - Every emission is a full recompute from DagStore.
 * - Emits ONLY through the ephemeral GlobalBus path — no EventV2 durable
 *   registration, no SQL writes.
 * - Removing this module has no effect on correctness; only realtime push is lost.
 */

// The events that can change a workflow's visible progress or topology.
// WorkflowCreated/Started/Replanned/ConfigUpdated/Paused/Resumed/Completed/Failed/Cancelled
// and every Node* event can all alter the aggregated summary.
const SUMMARY_TRIGGER_EVENTS = [
  DagEvent.WorkflowCreated,
  DagEvent.WorkflowStarted,
  DagEvent.WorkflowPaused,
  DagEvent.WorkflowResumed,
  DagEvent.WorkflowCompleted,
  DagEvent.WorkflowFailed,
  DagEvent.WorkflowCancelled,
  DagEvent.WorkflowReplanned,
  DagEvent.WorkflowConfigUpdated,
  DagEvent.NodeRegistered,
  DagEvent.NodeStarted,
  DagEvent.NodeCompleted,
  DagEvent.NodeFailed,
  DagEvent.NodeSkipped,
  DagEvent.NodeCancelled,
  DagEvent.NodeRestarted,
] as const

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DagSummaryPublisher") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service

    const state = yield* InstanceState.make(
      Effect.fn("DagSummaryPublisher.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        // Per workspace/session debounce map. Keys identify a routed session
        // with an in-flight recompute; a bounded window collapses a burst.
        //
        // NOTE: This is request-coalescing state for I/O deduplication, NOT
        // a parallel projection of DAG state. The summary is always recomputed
        // fresh from DagStore on emission; this map only prevents redundant
        // reads when many events fire in a tight window. If the map were
        // removed entirely, correctness is unchanged — only more DagStore
        // reads would occur. This satisfies the "stateless derived view"
        // contract: no cached summary is ever served from this map.
        const pending = new Set<string>()
        // Second coalescing tier keyed by workspace/dagID: node events don't
        // carry a sessionID, and resolving it eagerly meant one getWorkflow
        // query PER EVENT before the debounce window could absorb the burst
        // (P1-4). Resolve the sessionID once after the window, then hand off
        // to the workspace/session debounce.
        const pendingByDag = new Set<string>()

        const publishForSession = (sessionID: string, workspace: string | undefined) =>
          Effect.gen(function* () {
            const summaries = yield* store.getWorkflowSummaries(sessionID)
            GlobalBus.emit("event", {
              directory: ctx.directory,
              project: ctx.project.id,
              workspace,
              payload: {
                type: "dag.workflow.summary.updated",
                properties: { sessionID, summaries },
              },
            })
          })

        const schedulePublish = (sessionID: string, workspace: string | undefined) =>
          Effect.gen(function* () {
            const key = `${workspace ?? ""}\0${sessionID}`
            // Coalesce: if a recompute is already scheduled for this route,
            // let it absorb this trigger rather than queueing a second read.
            // The coalesced early return MUST NOT touch `pending` — only the
            // owning fiber clears its own slot, otherwise a coalesced caller
            // would delete the owner's entry and reopen the window.
            if (pending.has(key)) return
            pending.add(key)
            yield* Effect.gen(function* () {
              yield* Effect.sleep("50 millis")
              yield* publishForSession(sessionID, workspace)
            }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(key))))
          })

        const schedulePublishByDag = (dagID: string, workspace: string | undefined) =>
          Effect.gen(function* () {
            const key = `${workspace ?? ""}\0${dagID}`
            if (pendingByDag.has(key)) return
            pendingByDag.add(key)
            yield* Effect.gen(function* () {
              yield* Effect.sleep("50 millis")
              const wf = yield* store.getWorkflow(dagID)
              if (wf?.projectId !== ctx.project.id) return
              // Hand off to the session-level debounce (not publishForSession
              // directly) so a concurrent session-keyed window absorbs this
              // trigger instead of producing a duplicate read.
              yield* schedulePublish(wf.sessionId, workspace)
            }).pipe(Effect.ensuring(Effect.sync(() => pendingByDag.delete(key))))
          })

        const unsubscribe = yield* events.listen((evt) => {
          if (!SUMMARY_TRIGGER_EVENTS.some((def) => def.type === evt.type)) return Effect.void
          if (evt.location?.directory !== ctx.directory) return Effect.void
          const data = evt.data
          if (
            typeof data !== "object"
            || data === null
            || !("dagID" in data)
            || typeof data.dagID !== "string"
          ) return Effect.void
          const dagID = data.dagID
          return schedulePublishByDag(dagID, evt.location.workspaceID).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DagSummaryPublisher: failed to publish summaries", { dagID, cause }),
            ),
            Effect.forkIn(scope),
            Effect.asVoid,
          )
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        return {}
      }),
    )

    const init = Effect.fn("DagSummaryPublisher.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, DagStore.node])
