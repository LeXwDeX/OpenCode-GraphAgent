/**
 * DagLoop guard regressions:
 *
 * 1. Cross-instance adoption (P0): DagLoop is per-directory InstanceState but
 *    the event bus and store are process-global. Only the instance whose
 *    project owns a workflow may adopt it — at WorkflowStarted AND at startup
 *    recovery. Regression: a foreign instance won the first-wave spawn race
 *    and children ran under the wrong directory context.
 *
 * 2. Subscription survival (P1): orDie defects punch through Effect.ignore
 *    (it only absorbs the error channel) and killed the forked runForEach
 *    fiber, leaving that event type permanently unhandled. Handlers are now
 *    guarded with catchCause.
 *
 * 3. Cancel-skip race (P1): workflow-level cancel publishes NodeSkipped for
 *    running nodes; when that handler won the cross-stream race against
 *    WorkflowCancelled it deleted the fiber uninterrupted and the child
 *    session kept running. The NodeSkipped handler now aborts live fibers.
 */
import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { WorkflowNodeTable, WorkflowTable } from "@opencode-ai/core/dag/sql"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

interface PromptGate {
  readonly title: string
  readonly input: SessionPrompt.PromptInput
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
    Effect.timeoutOption("1 second"),
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new Error(message)),
      onSome: Effect.succeed,
    })),
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

function guardLayer(input: {
  readonly childPrompts: Queue.Queue<PromptGate>
  readonly cancels: string[]
  /** Injected one-shot defects for DagStore.getWorkflow (P1 survival test). */
  readonly failGetWorkflow?: { remaining: number }
}) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const realStore = DagStore.layer.pipe(Layer.provide(database))
  const store = input.failGetWorkflow
    ? Layer.effect(
        DagStore.Service,
        Effect.gen(function* () {
          const real = yield* DagStore.Service
          return DagStore.Service.of({
            ...real,
            getWorkflow: (id) =>
              Effect.suspend(() => {
                if (input.failGetWorkflow!.remaining > 0) {
                  input.failGetWorkflow!.remaining--
                  return Effect.die(new Error("injected transient db failure"))
                }
                return real.getWorkflow(id)
              }),
          })
        }),
      ).pipe(Layer.provide(realStore))
    : realStore
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
  )
  const dag = Dag.layer.pipe(
    Layer.provide(bridge),
    Layer.provide(store),
  )
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
      input: value,
      release,
    })
    return reply(sessionID, yield* Deferred.await(release))
  })
  const prompt = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    cancel: (sessionID) =>
      Effect.sync(() => {
        input.cancels.push(sessionID as string)
      }),
    prompt: deliver,
    promptIfIdle: (value) => deliver(value).pipe(Effect.map(Option.some)),
  }))
  const agent = Layer.mock(Agent.Service, {
    get: () => Effect.succeed({
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
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
  )
  return Layer.merge(base, loop)
}

function runGuardTest<A>(
  options: {
    /** Project the current instance belongs to. */
    readonly instanceProject: string
    readonly failGetWorkflow?: { remaining: number }
  },
  test: (services: {
    readonly dag: Dag.Interface
    readonly loop: DagLoop.Interface
    readonly store: DagStore.Interface
    readonly childPrompts: Queue.Queue<PromptGate>
    readonly cancels: string[]
  }) => Effect.Effect<A, Error>,
  beforeInit?: (services: { readonly database: Database.Interface }) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    const cancels: string[] = []
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const database = yield* Database.Service
      // Two projects sharing the process-global store, one session in each.
      for (const project of ["project-1", "project-2"]) {
        yield* database.db.insert(ProjectTable).values({
          id: project as never,
          worktree: process.cwd() as never,
          sandboxes: [],
        }).run().pipe(Effect.orDie)
        yield* database.db.insert(SessionTable).values({
          id: `ses_${project}` as never,
          project_id: project as never,
          slug: project,
          directory: process.cwd() as never,
          title: `Parent of ${project}`,
          version: "test",
        }).run().pipe(Effect.orDie)
      }
      if (beforeInit) yield* beforeInit({ database })
      yield* loop.init()
      return yield* test({ dag, loop, store, childPrompts, cancels })
    }).pipe(
      Effect.provide(guardLayer({ childPrompts, cancels, failGetWorkflow: options.failGetWorkflow })),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: options.instanceProject },
      } as never),
      Effect.scoped,
    )
  })
}

describe("DagLoop cross-instance adoption guard", () => {
  it("does not adopt a foreign project's workflow at WorkflowStarted", async () => {
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-2" }, ({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_project-1",
            title: "Foreign workflow",
            config: { name: "foreign", nodes: [node({ id: "foreign-node", name: "foreign-node" })] },
          })
          // Give the (wrongly subscribed) handler time to act, then assert
          // nothing spawned and the durable node is untouched.
          yield* Effect.sleep("300 millis")
          expect(Option.isNone(yield* Queue.poll(childPrompts))).toBe(true)
          const nodes = yield* store.getNodes(dagID)
          expect(nodes).toHaveLength(1)
          expect(nodes[0].status).toBe("pending")
        }),
      ),
    )
  })

  it("adopts and spawns its own project's workflow (control)", async () => {
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-2" }, ({ dag, childPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-2",
            sessionID: "ses_project-2",
            title: "Own workflow",
            config: { name: "own", nodes: [node({ id: "own-node", name: "own-node" })] },
          })
          const child = yield* takeWithin(childPrompts, "own-project node did not start")
          expect(child.title).toBe("own-node")
          yield* Deferred.succeed(child.release, "done")
        }),
      ),
    )
  })

  it("does not reconcile a foreign project's running workflow at startup recovery", async () => {
    await Effect.runPromise(
      runGuardTest(
        { instanceProject: "project-2" },
        ({ store, cancels }) =>
          Effect.gen(function* () {
            yield* Effect.sleep("300 millis")
            // Without the guard, recovery invents an ownership-lost failure
            // and cancels the child session. The foreign row must stay put.
            const nodes = yield* store.getNodes("foreign-recovery")
            expect(nodes[0].status).toBe("running")
            expect(cancels).toHaveLength(0)
          }),
        ({ database }) =>
          database.db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(WorkflowTable).values({
                id: "foreign-recovery",
                project_id: "project-1" as never,
                session_id: "ses_project-1" as never,
                title: "Foreign running workflow",
                status: "running",
                config: "{}",
                seq: 10,
              }).run()
              yield* tx.insert(WorkflowNodeTable).values({
                id: "orphan-node",
                workflow_id: "foreign-recovery",
                name: "orphan-node",
                worker_type: "build",
                status: "running",
                required: true,
                depends_on: [],
                child_session_id: "ses_orphan",
                seq: 9,
              }).run()
            }),
          ).pipe(Effect.orDie),
      ),
    )
  })
})

describe("DagLoop subscription survival", () => {
  it("keeps processing WorkflowStarted after a handler defect", async () => {
    await Effect.runPromise(
      runGuardTest(
        { instanceProject: "project-1", failGetWorkflow: { remaining: 1 } },
        ({ dag, childPrompts }) =>
          Effect.gen(function* () {
            // First workflow: the handler's getWorkflow dies (injected defect).
            // The guarded boundary must log-and-survive, not kill the stream.
            yield* dag.create({
              projectID: "project-1",
              sessionID: "ses_project-1",
              title: "Poisoned workflow",
              config: { name: "poisoned", nodes: [node({ id: "poisoned-node", name: "poisoned-node" })] },
            })
            yield* Effect.sleep("200 millis")
            // Second workflow on the same subscription must still spawn.
            yield* dag.create({
              projectID: "project-1",
              sessionID: "ses_project-1",
              title: "Healthy workflow",
              config: { name: "healthy", nodes: [node({ id: "healthy-node", name: "healthy-node" })] },
            })
            const child = yield* takeWithin(childPrompts, "subscription died after defect — healthy workflow never spawned")
            expect(child.title).toBe("healthy-node")
            yield* Deferred.succeed(child.release, "done")
          }),
      ),
    )
  })
})

describe("DagLoop cancel-skip race", () => {
  it("aborts the live child session when NodeSkipped lands on a running node", async () => {
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-1" }, ({ dag, store, childPrompts, cancels }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_project-1",
            title: "Skip race",
            config: { name: "skip-race", nodes: [node({ id: "racy-node", name: "racy-node" })] },
          })
          // Node is running: its prompt is parked on the deferred gate.
          const child = yield* takeWithin(childPrompts, "racy-node did not start")
          const childSessionID = child.input.sessionID as string
          // Simulate the workflow-cancel skip arriving before the
          // WorkflowCancelled sweep: publish NodeSkipped directly.
          yield* dag.nodeSkipped(dagID, "racy-node", "workflow_cancelled")
          // The handler must abort the child instead of orphaning its fiber.
          yield* pollWithTimeout(
            Effect.sync(() => (cancels.includes(childSessionID) ? true as const : undefined)),
            "NodeSkipped handler did not cancel the live child session",
          )
          const updated = yield* store.getNode(dagID, "racy-node")
          expect(updated?.status).toBe("skipped")
        }),
      ),
    )
  })
})
