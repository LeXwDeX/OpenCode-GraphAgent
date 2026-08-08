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
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"

interface PromptGate {
  readonly title: string
  readonly release: Deferred.Deferred<string>
}

interface ParentPromptGate {
  readonly release: Deferred.Deferred<"success" | "failure">
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption("2 seconds"),
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
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: sessionID as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: text ? [{ type: "text", text }] as never : [],
  }
}

function node(id: string, dependsOn: string[] = [], timeoutMs?: number): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    report_to_parent: true,
    ...(timeoutMs ? { worker_config: { timeout_ms: timeoutMs } } : {}),
  }
}

function loopLayer(input: {
  readonly childPrompts: Queue.Queue<PromptGate>
  readonly parentPrompts: Queue.Queue<ParentPromptGate>
}) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
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
    if (sessionID === "ses_parent") {
      const release = yield* Deferred.make<"success" | "failure">()
      yield* Queue.offer(input.parentPrompts, { release })
      const outcome = yield* Deferred.await(release)
      if (outcome === "failure") return yield* Effect.die(new Error("provider unavailable"))
      return reply(sessionID, "parent handled wake")
    }
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(input.childPrompts, {
      title: childTitles.get(sessionID) ?? sessionID,
      release,
    })
    return reply(sessionID, yield* Deferred.await(release))
  })
  const prompt = Layer.mock(SessionPrompt.Service, {
    cancel: () => Effect.void,
    prompt: deliver,
    promptIfIdle: (value) => deliver(value).pipe(Effect.map(Option.some)),
  })
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

function runLoopTest<A>(
  test: (services: {
    readonly dag: Dag.Interface
    readonly store: DagStore.Interface
    readonly childPrompts: Queue.Queue<PromptGate>
    readonly parentPrompts: Queue.Queue<ParentPromptGate>
  }) => Effect.Effect<A, Error>,
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    const parentPrompts = yield* Queue.unbounded<ParentPromptGate>()
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const database = yield* Database.Service
      yield* database.db.insert(ProjectTable).values({
        id: "project-1" as never,
        worktree: process.cwd() as never,
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({
        id: "ses_parent" as never,
        project_id: "project-1" as never,
        slug: "parent",
        directory: process.cwd() as never,
        title: "Parent",
        version: "test",
      }).run().pipe(Effect.orDie)
      yield* loop.init()
      return yield* test({ dag, store, childPrompts, parentPrompts })
    }).pipe(
      Effect.provide(loopLayer({ childPrompts, parentPrompts })),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: "project-1" },
      } as never),
      Effect.scoped,
    )
  })
}

describe("DagLoop replan vs stale NodeFailed", () => {
  it("does not terminalize the old graph while a replacement graph is being applied", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Replan completion guard",
            config: {
              name: "replan-completion-guard",
              nodes: [{ ...node("a"), required: false }],
            },
          })
          expect((yield* takeWithin(childPrompts, "a did not start")).title).toBe("a")

          const plan = yield* dag.replan(dagID, {
            nodes: [
              { ...node("a"), required: false, cancel: true },
              node("b"),
            ],
          })
          expect(plan.cancel).toEqual(["a"])
          expect(plan.add).toEqual(["b"])

          const state = yield* pollWithTimeout(
            Effect.all({
              workflow: store.getWorkflow(dagID),
              replacement: store.getNode(dagID, "b"),
            }).pipe(
              Effect.map((current) =>
                current.workflow?.status !== "running" || current.replacement?.status === "running"
                  ? current
                  : undefined,
              ),
            ),
            "replacement graph did not settle",
          )
          expect(state.workflow?.status).toBe("running")
          const cancelled = yield* store.getNode(dagID, "a")
          expect(cancelled?.status).toBe("failed")
          expect(cancelled?.errorReason).toBe("cancelled via replan")
          expect(cancelled?.errorClass).toBeNull()
          const replacement = yield* takeWithin(childPrompts, "replacement b did not start")
          expect(replacement.title).toBe("b")
          expect(state.replacement?.status).toBe("running")
          yield* Deferred.succeed(replacement.release, "done")
        }),
      ),
    )
  })

  it("interrupts the replan-restarted node's old fiber so its timeout cannot poison the new generation", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Replan stale",
            config: { name: "replan-stale", nodes: [node("a", [], 500)] },
          })
          const firstA = yield* takeWithin(childPrompts, "a did not start")
          expect(firstA.title).toBe("a")

          // Pause so the restarted node is NOT immediately respawned by the
          // WorkflowReplanned handler — this is exactly the window where only
          // the replan fiber sweep stands between the old fiber's timeout and
          // the new-generation pending row (pending→failed is a legal
          // projection, so a stale NodeFailed would weld the node to failed).
          yield* dag.pause(dagID)
          yield* Effect.sleep("150 millis")

          const plan = yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 500), restart: true }] })
          expect(plan.restart).toEqual(["a"])
          expect((yield* store.getNode(dagID, "a"))?.status).toBe("pending")

          // Wait past the old attempt's deadline (admission + 500ms). Had the
          // old fiber survived the replan, its timeout path would have
          // published NodeFailed and flipped the pending row to failed.
          yield* Effect.sleep("800 millis")
          const nodeA = yield* store.getNode(dagID, "a")
          expect(nodeA?.status).toBe("pending")
          expect(nodeA?.errorReason).toBeNull()

          // The node stays schedulable in the new generation.
          yield* dag.resume(dagID)
          const secondA = yield* takeWithin(childPrompts, "a was not rescheduled after resume")
          expect(secondA.title).toBe("a")
          yield* Deferred.succeed(secondA.release, "done")

          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? workflow : undefined),
            ),
            "workflow did not complete after the restarted node reran",
          )
          const parent = yield* takeWithin(parentPrompts, "terminal wake did not reach the parent")
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  it("still settles a genuine failure: DB=failed drives markUnsatisfied and the required cascade", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Genuine failure",
            config: {
              name: "genuine-failure",
              // Extension cap 0: the first deadline exhausts the cap and the
              // watcher force-cancels + fails the node (timeout = signal until
              // the cap runs out — this test exercises the cap-exhausted path).
              max_timeout_extensions: 0,
              nodes: [node("a", [], 300), node("b", ["a"])],
            },
          })
          const gate = yield* takeWithin(childPrompts, "a did not start")
          expect(gate.title).toBe("a")
          // Never release — the node times out for real (DB row becomes
          // failed), so the NodeFailed handler's DB cross-check confirms and
          // the required-failure cascade must fail the workflow.
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "failed" ? workflow : undefined),
            ),
            "workflow did not fail after the required node timed out",
          )
          const nodeA = yield* store.getNode(dagID, "a")
          expect(nodeA?.status).toBe("failed")
          expect(nodeA?.errorReason).toContain("timeout")
          // b never ran: its only required dependency failed, and the
          // workflow-fail terminalization skipped it.
          expect((yield* store.getNode(dagID, "b"))?.status).toBe("skipped")
          expect(Option.isNone(yield* Queue.poll(childPrompts))).toBe(true)
          const parent = yield* takeWithin(parentPrompts, "failure wake did not reach the parent")
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  it("keeps dependents pending while paused; terminalizes them to skipped on resume after a required failure", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Paused required failure",
            config: { name: "paused-required-failure", nodes: [node("a"), node("b", ["a"])] },
          })
          const gate = yield* takeWithin(childPrompts, "a did not start")
          expect(gate.title).toBe("a")

          // Pause first, then fail the required node. A paused workflow cannot
          // transition to failed, so the dependent must stay pending (no
          // skipped terminalization) until the scheduler evaluates on resume.
          yield* dag.pause(dagID)
          yield* Deferred.succeed(gate.release, "")

          yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.status === "failed" ? current : undefined),
            ),
            "required node did not fail while the workflow was paused",
          )
          expect((yield* store.getWorkflow(dagID))?.status).toBe("paused")
          expect((yield* store.getNode(dagID, "b"))?.status).toBe("pending")

          yield* dag.resume(dagID)
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "failed" ? workflow : undefined),
            ),
            "workflow did not fail after resuming with a required failure",
          )
          const nodeB = yield* store.getNode(dagID, "b")
          expect(nodeB?.status).toBe("skipped")
          expect(nodeB?.errorReason).toBe("workflow_failed")
          const parent = yield* takeWithin(parentPrompts, "failure wake did not reach the parent")
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  it("rebuilds the graph from a restarted node's new depends_on (restart + rewired deps)", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Restart rewire",
            config: { name: "restart-rewire", nodes: [node("a"), node("b", ["a"])] },
          })
          const gateA = yield* takeWithin(childPrompts, "a did not start")
          expect(gateA.title).toBe("a")
          yield* Deferred.succeed(gateA.release, "done")
          const gateB = yield* takeWithin(childPrompts, "b did not start")
          expect(gateB.title).toBe("b")

          // Restart b mid-flight, rewiring its dependency from a → c (new node).
          const plan = yield* dag.replan(dagID, {
            nodes: [
              { ...node("b", ["c"]), restart: true },
              node("c"),
            ],
          })
          expect(plan.restart).toEqual(["b"])
          expect(plan.add).toEqual(["c"])

          // New graph: c is b's only dependency. If the stale b→a edge
          // survived the rebuild, b (a already completed) would be re-ready
          // immediately and its prompt would arrive before c's — the take
          // below would then fail with the wrong title.
          const gateC = yield* takeWithin(childPrompts, "c did not start first under the rewired graph")
          expect(gateC.title).toBe("c")
          const bRow = yield* store.getNode(dagID, "b")
          expect(bRow?.status).toBe("pending")
          expect(bRow?.dependsOn).toEqual(["c"])
          yield* Deferred.succeed(gateC.release, "done")

          const gateB2 = yield* takeWithin(childPrompts, "b was not rescheduled after its new dependency completed")
          expect(gateB2.title).toBe("b")
          yield* Deferred.succeed(gateB2.release, "done")

          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? workflow : undefined),
            ),
            "workflow did not complete under the rewired graph",
          )
          const parent = yield* takeWithin(parentPrompts, "terminal wake did not reach the parent")
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  it("keeps a mid-flight replan restart schedulable when the node is immediately ready again", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Restart ready",
            config: { name: "restart-ready", nodes: [node("a", [], 500)] },
          })
          const firstA = yield* takeWithin(childPrompts, "a did not start")
          expect(firstA.title).toBe("a")

          // Running workflow: the restarted node is ready again right away, so
          // spawnReady replaces the fiber. The old attempt's deadline passing
          // must not fail the new attempt (stale NodeFailed dropped by the DB
          // status cross-check — the row is running, not failed).
          const plan = yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 2000), restart: true }] })
          expect(plan.restart).toEqual(["a"])

          const secondA = yield* takeWithin(childPrompts, "a was not respawned after restart")
          expect(secondA.title).toBe("a")
          yield* Effect.sleep("700 millis")
          expect((yield* store.getNode(dagID, "a"))?.status).toBe("running")

          yield* Deferred.succeed(secondA.release, "done")
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? workflow : undefined),
            ),
            "workflow did not complete after the restarted node reran",
          )
          const parent = yield* takeWithin(parentPrompts, "terminal wake did not reach the parent")
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })
})
