import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { DagStore, type WorkflowRow, type WorkflowSummary } from "@opencode-ai/core/dag/store"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagSummaryPublisher } from "@/dag/runtime/summary-publisher"
import { GlobalBus } from "@/bus/global"
import { InstanceState } from "@/effect/instance-state"
import { it, pollWithTimeout } from "../lib/effect"

const ts = (n: number) => DateTime.makeUnsafe(n)

interface SummaryEmission {
  sessionID: string
  summaries: WorkflowSummary[]
  workspace?: string
}

interface StoreControl {
  failures: number
  reads: Map<string, number>
  lookups: Map<string, number>
  projects: Map<string, string>
  sessions: Map<string, string>
  summaries: Map<string, WorkflowSummary[]>
}

interface EventControl {
  listener?: (event: never) => Effect.Effect<void>
}

function control() {
  return {
    failures: 0,
    reads: new Map<string, number>(),
    lookups: new Map<string, number>(),
    projects: new Map<string, string>(),
    sessions: new Map<string, string>(),
    summaries: new Map<string, WorkflowSummary[]>(),
  } satisfies StoreControl
}

function workflow(id: string, sessionId: string, projectId: string): WorkflowRow {
  return {
    id,
    projectId,
    sessionId,
    title: id,
    status: "running",
    config: "",
    seq: 0,
    wakeReported: false,
    startedAt: null,
    completedAt: null,
    timeCreated: 0,
    timeUpdated: 0,
  }
}

function summary(id: string, completedNodes: number): WorkflowSummary {
  return {
    id,
    title: id,
    status: "running",
    nodeCount: completedNodes,
    completedNodes,
    runningNodes: 0,
    failedNodes: 0,
    skippedNodes: 0,
    queuedNodes: 0,
  }
}

function runtime(state: StoreControl, bus: EventControl) {
  const store = Layer.mock(DagStore.Service, {
    getWorkflow: (dagID) =>
      Effect.sync(() => {
        state.lookups.set(dagID, (state.lookups.get(dagID) ?? 0) + 1)
        const sid = state.sessions.get(dagID)
        return sid ? workflow(dagID, sid, state.projects.get(dagID) ?? "global") : undefined
      }),
    getWorkflowSummaries: (sessionID) =>
      Effect.sync(() => {
        state.reads.set(sessionID, (state.reads.get(sessionID) ?? 0) + 1)
        if (state.failures > 0) {
          state.failures -= 1
          throw new Error("simulated summary read failure")
        }
        return state.summaries.get(sessionID) ?? []
      }),
  })
  const events = Layer.mock(EventV2Bridge.Service, {
    listen: (listener) =>
      Effect.sync(() => {
        bus.listener = listener as never
        return Effect.sync(() => {
          bus.listener = undefined
        })
      }),
  })
  const base = Layer.mergeAll(events, store)
  return Layer.provideMerge(DagSummaryPublisher.layer, base)
}

function startCollector() {
  const emissions: SummaryEmission[] = []
  const handler = (event: {
    workspace?: string
    payload?: { type?: string; properties?: { sessionID?: string; summaries?: WorkflowSummary[] } }
  }) => {
    if (event.payload?.type !== "dag.workflow.summary.updated") return
    emissions.push({
      sessionID: event.payload.properties!.sessionID!,
      summaries: event.payload.properties!.summaries!,
      ...(event.workspace ? { workspace: event.workspace } : {}),
    })
  }
  GlobalBus.on("event", handler)
  return { emissions, stop: () => GlobalBus.off("event", handler) }
}

function publishNodeEvents(
  bus: EventControl,
  dagID: string,
  count: number,
  foreignDirectory = false,
  workspaceID?: string,
) {
  if (!bus.listener) return Effect.die(new Error("publisher listener is not ready"))
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    yield* Effect.forEach(
      Array.from({ length: count }, (_, index) => index),
      (index) => bus.listener!({
        type: DagEvent.NodeRegistered.type,
        data: {
          dagID,
          nodeID: `${dagID}-node-${index}`,
          name: `Node ${index}`,
          workerType: "build",
          dependsOn: [],
          required: true,
          timestamp: ts(index),
        },
        location: {
          directory: foreignDirectory ? `${instance.directory}-foreign` : instance.directory,
          ...(workspaceID ? { workspaceID } : {}),
        },
      } as never),
      { discard: true },
    )
  })
}

function withCollector<A, E, R>(use: (collector: ReturnType<typeof startCollector>) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(startCollector),
    use,
    (collector) => Effect.sync(collector.stop),
  )
}

describe("DagSummaryPublisher behavior", () => {
  it.instance("a node completion triggers one fresh summary recompute", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-one", "ses-one")
    state.summaries.set("ses-one", [summary("dag-one", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-one", 1)
        yield* pollWithTimeout(
          Effect.sync(() => collector.emissions.length === 1 ? collector.emissions[0] : undefined),
          "summary publisher did not emit",
        )

        expect(state.reads.get("ses-one")).toBe(1)
        expect(collector.emissions[0]).toEqual({ sessionID: "ses-one", summaries: [summary("dag-one", 1)] })
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("five same-session node events coalesce into one read and emission", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-burst", "ses-burst")
    state.summaries.set("ses-burst", [summary("dag-burst", 5)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-burst", 5)
        yield* pollWithTimeout(
          Effect.sync(() => collector.emissions.length === 1 ? true : undefined),
          "coalesced summary was not emitted",
        )

        expect(state.reads.get("ses-burst")).toBe(1)
        // P1-4: the sessionID lookup for sessionID-less node events happens
        // once per debounce window, not once per event.
        expect(state.lookups.get("dag-burst")).toBe(1)
        expect(collector.emissions).toEqual([
          { sessionID: "ses-burst", summaries: [summary("dag-burst", 5)] },
        ])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("different sessions coalesce independently", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-a", "ses-a")
    state.sessions.set("dag-b", "ses-b")
    state.summaries.set("ses-a", [summary("dag-a", 1)])
    state.summaries.set("ses-b", [summary("dag-b", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* Effect.all([publishNodeEvents(bus, "dag-a", 3), publishNodeEvents(bus, "dag-b", 3)], {
          concurrency: "unbounded",
        })
        yield* pollWithTimeout(
          Effect.sync(() => collector.emissions.length === 2 ? true : undefined),
          "independent session summaries were not emitted",
        )

        expect(state.reads).toEqual(new Map([["ses-a", 1], ["ses-b", 1]]))
        expect(collector.emissions.map((item) => item.sessionID).toSorted()).toEqual(["ses-a", "ses-b"])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("failed reads release coordination and later events read fresh state", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.failures = 1
    state.sessions.set("dag-retry", "ses-retry")
    state.summaries.set("ses-retry", [summary("dag-retry", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-retry", 1)
        yield* pollWithTimeout(
          Effect.sync(() => state.reads.get("ses-retry") === 1 ? true : undefined),
          "failed summary read did not run",
        )
        expect(collector.emissions).toEqual([])

        state.summaries.set("ses-retry", [summary("dag-retry", 2)])
        yield* publishNodeEvents(bus, "dag-retry", 1)
        yield* pollWithTimeout(
          Effect.sync(() => collector.emissions.length === 1 ? true : undefined),
          "summary publisher did not recover after failure",
        )

        expect(state.reads.get("ses-retry")).toBe(2)
        expect(collector.emissions[0].summaries).toEqual([summary("dag-retry", 2)])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("ignores DAG events emitted by another project instance", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-foreign", "ses-foreign")
    state.summaries.set("ses-foreign", [summary("dag-foreign", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-foreign", 1, true)
        yield* Effect.sleep("150 millis")

        expect(state.lookups.size).toBe(0)
        expect(state.reads.size).toBe(0)
        expect(collector.emissions).toEqual([])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("ignores another project even when its event uses the same directory", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-foreign-project", "ses-foreign-project")
    state.projects.set("dag-foreign-project", "foreign-project")
    state.summaries.set("ses-foreign-project", [summary("dag-foreign-project", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-foreign-project", 1)
        yield* Effect.sleep("150 millis")

        expect(state.lookups.get("dag-foreign-project")).toBe(1)
        expect(state.reads.size).toBe(0)
        expect(collector.emissions).toEqual([])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("routes summary emissions to the workspace carried by the DAG event", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-workspace", "ses-workspace")
    state.summaries.set("ses-workspace", [summary("dag-workspace", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-workspace", 1, false, "wrk-origin")
        yield* pollWithTimeout(
          Effect.sync(() => collector.emissions[0]),
          "workspace summary was not emitted",
        )

        expect(collector.emissions[0]).toEqual({
          sessionID: "ses-workspace",
          summaries: [summary("dag-workspace", 1)],
          workspace: "wrk-origin",
        })
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })
})
