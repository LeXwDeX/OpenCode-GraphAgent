// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The incident
// harness deliberately mirrors dag-loop-guards.test.ts: mocked service layers
// and seeded row fixtures use `as never` type shims (mock objects implement
// only the interface slice the scenario exercises). The shims are type-only;
// converting them would fork the template's shape without changing behavior.
// oxlint-disable eslint/no-unused-vars -- gate objects are taken for their
// readiness side effect (takeWithin), not their value.
import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance } from "@/effect/instance-registry"
import { DagSupervisionSweep } from "@/dag/runtime/supervision-sweep"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

// Production-incident harness (2026-08-18, dag_fe5feabfcae607fqVdRh47lN1B):
// a coding node's child session LLM stream died silently mid-turn; the node
// stayed `running` past its deadline for 7.5+ hours with escalation_pending=0
// and timeout_extensions=0 — the deadline watcher never fired while the host
// process stayed alive. This harness reproduces the supervision shape at
// 2-second deadlines and asserts the invariant the incident violated:
//
//   A running node past its deadline must leave `running` (escalate or fail)
//   within a bounded window — no matter HOW the surrounding fibers die.
//
// Modes cover the candidate death paths:
//   stream-hang      — the child prompt never resolves (incident shape)
//   dispose-instance — the per-directory instance scope closes mid-run
//   healthy          — control: the watcher fires normally

interface PromptGate {
  readonly title: string
  readonly release: Deferred.Deferred<string>
}

function node(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id: "n1",
    name: "Node 1",
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: "work" },
    ...overrides,
  }
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption("2 seconds"),
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Error(message)), onSome: Effect.succeed })),
  )
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text }],
  } as never
}

function supervisionLayer(input: {
  readonly childPrompts: Queue.Queue<PromptGate>
  readonly cancels: string[]
}) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  const childTitles = new Map<string, string>()
  const created: string[] = []
  const session = Layer.mock(Session.Service, {
    get: () => Effect.succeed({ id: "ses_parent", permission: [], agent: "build" } as never),
    create: (value) =>
      Effect.sync(() => {
        const id = `ses_child_${created.length + 1}`
        created.push(id)
        childTitles.set(id, (value?.title ?? id).replace(" (DAG node)", ""))
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(input.childPrompts, {
      title: childTitles.get(sessionID) ?? sessionID,
      release,
    })
    return reply(sessionID, yield* Deferred.await(release))
  })
  const prompt = Layer.mock(
    SessionPrompt.Service,
    withIdleAdmission({
      cancel: (sessionID: string) =>
        Effect.sync(() => {
          input.cancels.push(sessionID)
        }),
      prompt: (value: SessionPrompt.PromptInput) => deliver(value),
      promptIfIdle: (value: SessionPrompt.PromptInput) => deliver(value).pipe(Effect.map(Option.some)),
    }),
  )
  const agent = Layer.mock(Agent.Service, {
    get: () =>
      Effect.succeed({
        name: "build",
        mode: "all",
        permission: [],
        options: {},
        description: "",
        prompt: "",
        model: { providerID: "test" as never, modelID: "test-model" as never },
        tools: {},
        hooks: {},
      }),
  })
  const loop = DagLoop.layer.pipe(Layer.provide(base), Layer.provide(session), Layer.provide(prompt), Layer.provide(agent))
  const sweep = DagSupervisionSweep.layerWithoutDeps.pipe(Layer.provide(base), Layer.provide(prompt))
  return Layer.merge(Layer.merge(base, loop), sweep)
}

interface SupervisionServices {
  readonly dag: Dag.Interface
  readonly loop: DagLoop.Interface
  readonly store: DagStore.Interface
  readonly sweep: import("@/dag/runtime/supervision-sweep").Interface
  readonly childPrompts: Queue.Queue<PromptGate>
  readonly cancels: string[]
  readonly database: Database.Interface
}
function runSupervisionTest<A>(options: { readonly instanceProject: string }, test: (services: SupervisionServices) => Effect.Effect<A, Error>) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    const cancels: string[] = []
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const sweep = yield* DagSupervisionSweep.Service
      const database = yield* Database.Service
      for (const project of ["project-1", "project-2"]) {
        yield* database.db
          .insert(ProjectTable)
          .values({ id: project as never, worktree: process.cwd() as never, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionTable)
          .values({
            id: `ses_${project}` as never,
            project_id: project as never,
            slug: project,
            directory: process.cwd() as never,
            title: `Parent of ${project}`,
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
      }
      yield* loop.init()
      return yield* test({ dag, loop, store, sweep, childPrompts, cancels, database })
    }).pipe(
      Effect.provide(supervisionLayer({ childPrompts, cancels })),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: options.instanceProject },
      } as never),
      Effect.scoped,
    )
  })
}

// Shared graph: one coding node with a 2-second worker timeout. nodeTimeoutMs
// default would make the deadline 10 minutes — unusable for a test. The cap
// is pinned to 1 escalation so cap enforcement lands inside the test window.
const incidentGraph = {
  projectID: "project-1",
  sessionID: "ses_project-1",
  title: "incident",
  config: {
    name: "incident",
    max_timeout_extensions: 1,
    nodes: [node({ id: "worker", name: "worker", worker_config: { timeout_ms: 2_000 } })],
  },
}

// The incident invariant, as a poll predicate: the node must leave `running`
// (any terminal status, or escalated-but-running counts as progress only if
// extensions climb — the incident had BOTH frozen at zero, so we assert on
// status change OR timeout_extensions > 0).
const supervisionProgress = (store: DagStore.Interface, dagID: string, nodeID: string) =>
  Effect.gen(function* () {
    const row = yield* store.getNode(dagID, nodeID)
    if (!row) return undefined
    if (row.status !== "running") return row
    if (row.timeoutExtensions > 0) return row
    return undefined
  })

// bun's default per-test timeout is 5s; several bodies here need 8-40s at a
// 2s deadline — run this file with --timeout 30000 (the CI suite default).
describe("DAG node supervision — deadline enforcement (production incident)", () => {
  it("healthy: a node past its deadline gets escalated by the watcher", async () => {
    await Effect.runPromise(
      runSupervisionTest({ instanceProject: "project-1" }, ({ dag, store, childPrompts, cancels }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create(incidentGraph)
          const child = yield* takeWithin(childPrompts, "worker did not start")
          // Leave the prompt unresolved past the 2s deadline: the watcher
          // must escalate (timeout_extensions climbs), then exhaust the cap
          // and force-cancel the child.
          yield* pollWithTimeout(
            supervisionProgress(store, dagID, "worker"),
            "watcher never escalated a node past its deadline (healthy control)",
            "8 seconds",
          )
          // Cap enforcement: max extensions default is 3 — after enough
          // escalations the watcher cancels the child and fails the node.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const row = yield* store.getNode(dagID, "worker")
              return row?.status === "failed" ? row : undefined
            }),
            "watcher never cap-enforced (cancel + nodeFailed(timeout))",
            "30 seconds",
          )
          expect(cancels.length).toBeGreaterThan(0)
        }),
      ),
    )
  })

  it("stream-hang: the incident shape — prompt never resolves, node still must not rot in running", async () => {
    await Effect.runPromise(
      runSupervisionTest({ instanceProject: "project-1" }, ({ dag, store, childPrompts }: SupervisionServices ) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create(incidentGraph)
          const child = yield* takeWithin(childPrompts, "worker did not start")
          // Incident shape: the LLM stream died — the prompt gate is never
          // released and never errors. Supervision must still progress.
          void child
          yield* pollWithTimeout(
            supervisionProgress(store, dagID, "worker"),
            "node rotted in running past its deadline with zero supervision progress (incident)",
            "8 seconds",
          )
        }),
      ),
    )
  })

  // H5 (instance-scope harvest): closing the per-directory instance state
  // mid-run interrupts every fiber forked into its scope — the DagLoop
  // subscriptions, the spawn execution fiber, AND the deadline watcher —
  // without touching the durable row. The production signature (a node stuck
  // in running with escalation frozen at zero for hours while the host kept
  // logging) is only reachable if supervision dies silently this way.
  it("dispose-instance: instance teardown mid-run freezes durable supervision (incident mechanism)", async () => {
    await Effect.runPromise(
      runSupervisionTest({ instanceProject: "project-1" }, ({ dag, store, sweep, childPrompts }: SupervisionServices) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create(incidentGraph)
          const child = yield* takeWithin(childPrompts, "worker did not start")
          void child
          // Wait for the first escalation so we know supervision was live.
          yield* pollWithTimeout(
            supervisionProgress(store, dagID, "worker"),
            "watcher never escalated before dispose",
            "8 seconds",
          )
          const extensionsAtDispose = (yield* store.getNode(dagID, "worker"))?.timeoutExtensions ?? 0
          // Dispose the instance (the production candidate: lifecycle/
          // directory cleanup) — silently reaps every in-scope fiber.
          yield* Effect.promise(() => disposeInstance(process.cwd()))
          // Give any surviving supervision ample time to escalate again.
          yield* Effect.sleep("4 seconds")
          const row = yield* store.getNode(dagID, "worker")
          // The frozen-supervision signature: still running, extensions
          // frozen at the dispose-time value, no cap enforcement.
          expect(row?.status).toBe("running")
          expect(row?.timeoutExtensions).toBe(extensionsAtDispose)

          // The fallback-retry contract (production fix): the HOST-LEVEL
          // supervision sweep — whose fiber lives in the layer scope and
          // survives the instance teardown — settles the frozen node once
          // its counter has stayed flat for FROZEN_TICKS_NEEDED ticks
          // (dead supervision; a live watcher always moves the counter
          // inside the window).
          const { FROZEN_TICKS_NEEDED } = DagSupervisionSweep
          for (let tick = 0; tick <= FROZEN_TICKS_NEEDED; tick++) {
            yield* sweep.sweepOnce()
            yield* Effect.sleep("50 millis")
          }
          const swept = yield* pollWithTimeout(
            Effect.gen(function* () {
              const settled = yield* store.getNode(dagID, "worker")
              return settled && settled.status !== "running" ? settled : undefined
            }),
            "host-level sweep never settled the node with dead supervision (fallback retry)",
            "5 seconds",
          )
          expect(swept?.errorClass).toBe("timeout")
        }),
      ),
    )
  })

  // Review R1 issue 2 (false-positive kill): a LIVE watcher on a node whose
  // escalation cadence spans multiple sweep intervals must never be swept —
  // the counter legitimately stays flat between escalations. The graph keeps
  // the default cap (20) so the watcher's ladder is the intended path; the
  // sweep passes run alongside a live watcher for well over the freeze
  // window, and the settle that eventually lands must carry the WATCHER's
  // own cap reason, never the sweep's.
  it("freeze window: a live watcher is never swept — only its own cap enforcement ends the node", async () => {
    await Effect.runPromise(
      runSupervisionTest({ instanceProject: "project-1" }, ({ dag, store, sweep, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            ...incidentGraph,
            config: { ...incidentGraph.config, max_timeout_extensions: 3 },
          })
          const child = yield* takeWithin(childPrompts, "worker did not start")
          void child
          // Supervision alive: the watcher escalates on its 2s cadence.
          yield* pollWithTimeout(
            supervisionProgress(store, dagID, "worker"),
            "watcher never escalated before the streak test",
            "8 seconds",
          )
          const { FROZEN_TICKS_NEEDED } = DagSupervisionSweep
          // Run more sweep passes than the freeze window alongside the live
          // watcher: its 2s escalation cadence resets the streak every time,
          // so the sweep must never fire.
          for (let tick = 0; tick < FROZEN_TICKS_NEEDED + 2; tick++) {
            yield* Effect.sleep("300 millis")
            yield* sweep.sweepOnce()
          }
          const row = yield* store.getNode(dagID, "worker")
          // Either still running (ladder ongoing) or terminalized by the
          // watcher's OWN cap — never by the sweep.
          if (row?.status === "failed") {
            expect(row?.errorReason).toContain("timeout extensions exhausted")
          } else {
            expect(row?.status).toBe("running")
          }
        }),
      ),
    )
  })
})
