import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { planReplan } from "@opencode-ai/core/dag/core/replan"
import { NodeStatus } from "@opencode-ai/core/dag/core/types"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Dag, type NodeConfig } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { reconcileWorkflow } from "@/dag/runtime/recovery"
import { makeDeadlineWatcher } from "@/dag/runtime/spawn"
import { SessionPrompt } from "@/session/prompt"
import { makeNodeRow } from "./fixtures"
import { awaitWithTimeout, pollWithTimeout } from "../lib/effect"

function node(id: string, timeoutMs?: number): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
    ...(timeoutMs !== undefined ? { worker_config: { timeout_ms: timeoutMs } } : {}),
  }
}

const harness = (() => {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  return Layer.mergeAll(database, events, bridge, store, projector, dag)
})()

function runTest<A>(
  test: (services: { readonly dag: Dag.Interface; readonly store: DagStore.Interface }) => Effect.Effect<A, Error>,
) {
  return Effect.gen(function* () {
    return yield* Effect.gen(function* () {
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
      const dag = yield* Dag.Service
      const store = yield* DagStore.Service
      return yield* test({ dag, store })
    }).pipe(
      Effect.provide(harness),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: "project-1" },
      } as never),
      Effect.scoped,
    )
  })
}

function createWorkflow(dag: Dag.Interface, title: string, timeoutMs?: number, nodeID = "a") {
  return dag.create({
    projectID: "project-1",
    sessionID: "ses_parent",
    title,
    config: { name: title, nodes: [node(nodeID, timeoutMs)] },
  })
}

describe("Dag timeout escalation fixes (unit)", () => {
  it("rejects a cycle introduced through a running node's replaced deps (P1a)", () => {
    // Both nodes are running and appear in the fragment WITHOUT a restart
    // marker → they land in the replace bucket: the fragment's deps are
    // re-published via NodeRegistered and the runtime rebuilds its graph from
    // them. The replan's cycle check must use the SAME deps (a→b, b→a = cycle).
    const plan = planReplan(
      { nodes: [
        { id: "a", status: NodeStatus.RUNNING, depends_on: [] },
        { id: "b", status: NodeStatus.RUNNING, depends_on: ["a"] },
      ] },
      { nodes: [
        { id: "a", depends_on: ["b"] },
        { id: "b", depends_on: ["a"] },
      ] },
    )
    expect(plan.errors.join(" ")).toContain("cycle")
  })

  it("rejects a replan whose running-node fragment deps form a cycle, leaving the node untouched (P1a)", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "P1a replan cycle",
            config: { name: "p1a", nodes: [node("a", 60_000)] },
          })
          yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() + 60_000, false)

          // The running node "a" is present in the fragment without a restart
          // marker (replace bucket): its NEW deps (a→b) are what the runtime
          // would execute, so the cycle a↔b must be caught BEFORE any event is
          // published — the replan is rejected, the running node is untouched.
          const exit = yield* dag.replan(dagID, {
            nodes: [
              { ...node("a", 60_000), depends_on: ["b"] },
              { ...node("b", 60_000), depends_on: ["a"] },
            ],
          }).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("cycle")
          }
          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("running")
          expect(row?.timeoutExtensions).toBe(0)
          expect(row?.childSessionId).toBe("ses_child_1")
        }),
      ),
    )
  })

  it("includes an escalated running node in the wake snapshot regardless of report_to_parent (F11)", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "f11-visible")
          yield* dag.nodeQueued(dagID, "a", Date.now() - 1000)
          // reportToParent=false (wake_eligible=false) — the default for most
          // nodes. The escalation must still reach the main agent.
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() - 1000, false)
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1)

          const snapshot = yield* store.getWakeSnapshot("ses_parent")
          const node = snapshot.nodes.find((candidate) => candidate.id === "a")
          expect(node).toBeTruthy()
          expect(node?.wakeEligible).toBe(false)
          expect(node?.status).toBe("running")
          expect(node?.timeoutExtensions).toBe(1)

          const unreported = yield* store.getUnreportedWakeNodes("ses_parent")
          expect(unreported.map((candidate) => candidate.id)).toContain("a")
          expect(yield* store.getSessionsWithUnreportedWakes()).toContain("ses_parent")
        }),
      ),
    )
  })

  it("keeps an escalated-then-failed node visible in the wake snapshot (F11 cap verdict)", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "f11-terminal")
          yield* dag.nodeQueued(dagID, "a", Date.now() - 1000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() - 1000, false)
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1)
          // Cap-exhausted force-cancel terminalizes the escalated node. Its
          // verdict (failed, extension count preserved) must re-enter the
          // snapshot even though wake_eligible=false.
          yield* dag.nodeFailed(dagID, "a", "timeout extensions exhausted (1/1)", "timeout")

          const snapshot = yield* store.getWakeSnapshot("ses_parent")
          const node = snapshot.nodes.find((candidate) => candidate.id === "a")
          expect(node).toBeTruthy()
          expect(node?.wakeEligible).toBe(false)
          expect(node?.status).toBe("failed")
          expect(node?.timeoutExtensions).toBe(1)
          expect(node?.errorReason).toContain("timeout extensions exhausted")

          const unreported = yield* store.getUnreportedWakeNodes("ses_parent")
          expect(unreported.map((candidate) => candidate.id)).toContain("a")
        }),
      ),
    )
  })

  it("clamps a zero timeout_ms to the floor on create (F9)", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "zero-timeout", 0)
          const wf = yield* store.getWorkflow(dagID)
          const config = JSON.parse(wf!.config) as { nodes: NodeConfig[] }
          expect(config.nodes[0].worker_config?.timeout_ms).toBe(1000)
        }),
      ),
    )
  })

  it("clamps a negative timeout_ms to the floor on create (F9)", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "negative-timeout", -5)
          const wf = yield* store.getWorkflow(dagID)
          const config = JSON.parse(wf!.config) as { nodes: NodeConfig[] }
          expect(config.nodes[0].worker_config?.timeout_ms).toBe(1000)
        }),
      ),
    )
  })

  it("ignores a timeout escalation landing on a terminal node (F2a ghost wake)", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "ghost-wake", 60_000)
          yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() + 60_000, false)
          // The node fails before any timeout can fire.
          yield* dag.nodeFailed(dagID, "a", "provider exploded", "exec_failed")
          // A stale escalation races in after the terminal event.
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1).pipe(Effect.ignore)
          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("failed")
          expect(row?.timeoutExtensions).toBe(0)
        }),
      ),
    )
  })

  it("ignores a stale escalation landing on a completed node (F2a completed race)", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "ghost-wake-completed", 60_000)
          yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() + 60_000, true)
          // The child finishes first; the completion wins the race.
          yield* dag.nodeCompleted(dagID, "a", "done")
          // A stale escalation from the watcher fiber races in afterwards.
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1).pipe(Effect.ignore)
          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("completed")
          // Neither the extension counter nor the re-armed wake flag may be
          // touched on the terminal row — the escalation guard rejects the
          // UPDATE entirely (0 rows), so the completion wake stays exactly as
          // NodeCompleted left it.
          expect(row?.timeoutExtensions).toBe(0)
          expect(row?.wakeReported).toBe(false)
        }),
      ),
    )
  })

  it("keeps an escalation counter on an escalated node, then marks its recovery failure as timeout (S2)", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "recovery-escalated", 60_000)
          yield* dag.nodeQueued(dagID, "a", Date.now() - 1000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() - 1000, true)
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 2)
          const pre = yield* store.getNode(dagID, "a")
          expect(pre?.status).toBe("running")
          expect(pre?.timeoutExtensions).toBe(2)

          // Crash recovery: the child session is gone ("unknown"), the deadline
          // was already exceeded and the durable counter proves the escalation.
          const result = yield* reconcileWorkflow(
            dagID,
            () => Effect.succeed("unknown" as const),
            () => Effect.void,
            undefined,
          ).pipe(Effect.provideService(Dag.Service, dag))
          expect(result.reconciled).toBe(1)
          expect(result.ownershipLost).toBe(1)
          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("failed")
          expect(row?.errorClass).toBe("timeout")
          expect(row?.errorReason).toContain("timeout escalated (2 extension(s))")
        }),
      ),
    )
  })

  it("marks a recovery failure of an escalated node that never passed its deadline as ownership loss (S2)", async () => {
    await Effect.runPromise(
      runTest(({ dag, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "recovery-escalated-future", 60_000)
          yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() + 60_000, true)
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1)
          const result = yield* reconcileWorkflow(
            dagID,
            () => Effect.succeed("unknown" as const),
            () => Effect.void,
            undefined,
          ).pipe(Effect.provideService(Dag.Service, dag))
          expect(result.ownershipLost).toBe(1)
          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("failed")
          expect(row?.errorClass).toBe("exec_failed")
          expect(row?.errorReason).toContain("execution ownership lost on recovery")
        }),
      ),
    )
  })

  it("retries transient store read failures instead of exiting supervision (R13)", async () => {
    let reads = 0
    let escalations = 0
    const dagLayer = Layer.mock(Dag.Service, {
      store: {
        getNode: () =>
          Effect.sync(() => {
            reads++
            // 3 transient failures (e.g. SQLite lock blips) — the watcher
            // must survive them and keep supervising.
            if (reads <= 3) throw new Error("database locked")
            return makeNodeRow({
              id: "a",
              workflowId: "dag-r13",
              name: "a",
              status: "running",
              deadlineMs: 1,
              timeoutExtensions: 0,
              childSessionId: "ses_child_1",
            })
          }),
      } as unknown as DagStore.Interface,
      nodeTimeoutEscalated: () => Effect.sync(() => { escalations++ }),
    })
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      cancel: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const watcher = yield* makeDeadlineWatcher({ dagID: "dag-r13", nodeID: "a", timeoutMs: 300 }).pipe(
          Effect.forkIn(scope),
        )
        // The watcher escalates once the row is readable — proof the transient
        // failures did not end supervision (1 initial read + 3 retries).
        yield* pollWithTimeout(
          Effect.sync(() => (escalations > 0 ? true : undefined)),
          "watcher did not escalate after transient store failures (R13 regression)",
        )
        expect(reads).toBe(4)
        yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
      }).pipe(
        Effect.provide(dagLayer),
        Effect.provide(promptLayer),
        Effect.scoped,
      ),
    )
  })

  it("continues supervision after store read retries fail (R13/F1-product)", async () => {
    let reads = 0
    const dagLayer = Layer.mock(Dag.Service, {
      store: {
        getNode: () =>
          Effect.sync(() => {
            reads++
            throw new Error("database locked")
          }),
      } as unknown as DagStore.Interface,
    })
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      cancel: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const watcher = yield* makeDeadlineWatcher({ dagID: "dag-r13", nodeID: "a", timeoutMs: 300 }).pipe(
          Effect.forkIn(scope),
        )
        // After 4 failed reads (1 + 3 retries), the watcher does NOT exit —
        // it sleeps 5s then retries. Wait for the 5th read via a fence rather
        // than a fixed sleep, so the test does not race the 5s retry boundary
        // under CI scheduling jitter (reads becomes > 4 at ~6.5s; 12s budget
        // sits under the 15s test timeout).
        yield* pollWithTimeout(
          Effect.sync(() => (reads > 4 ? true : undefined)),
          "watcher exited instead of continuing supervision after store-read retry exhaustion (R13/F1-product)",
          "12 seconds",
        )
        yield* Fiber.interrupt(watcher)
        expect(reads).toBeGreaterThan(4)
      }).pipe(
        Effect.provide(dagLayer),
        Effect.provide(promptLayer),
        Effect.scoped,
      ),
    )
  }, 15000)
})
