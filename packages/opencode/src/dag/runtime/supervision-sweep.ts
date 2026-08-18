// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagSupervisionSweep from "./supervision-sweep"

import { Context, Effect, Fiber, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowNodeTable } from "@opencode-ai/core/dag/sql"
import { and, eq, sql } from "drizzle-orm"
import { Dag } from "@/dag/dag"
import { SessionPrompt } from "@/session/prompt"

/**
 * Host-level deadline-supervision sweep — the fallback retry for the
 * production incident (2026-08-18, dag_fe5feabfcae607fqVdRh47lN1B):
 *
 * A per-directory instance teardown (lifecycle cleanup, directory switch,
 * config change) silently reaps every fiber forked into its scope — the
 * DagLoop subscriptions, the spawn execution fiber, AND the deadline
 * watcher — while the durable node row stays `running`. Because the host
 * process keeps running, nothing ever re-arms supervision: the node rots in
 * `running` past its deadline with `timeout_extensions` frozen for hours
 * (7.5h observed). Re-init/crash recovery CAN settle such rows, but only
 * when something re-triggers the instance — and in a live host nothing
 * does.
 *
 * This sweep is deliberately NOT forked into any per-directory
 * InstanceState scope: its repeating fiber is forked into the LAYER scope
 * at construction and lives for the process lifetime. It must therefore
 * never depend on ambient per-instance context (InstanceRef) — its fiber's
 * context is the layer-build context, which has none. Ownership is decided
 * from the durable rows alone: this process's Database owns every workflow
 * row it can read, and the nodeFailed guard under the workflow lock
 * serializes any race with another writer (including a second host sharing
 * the DB — double settles collapse to one).
 *
 * False-positive safety: a LIVE watcher escalates on
 * escalateIntervalMs == max(1s, timeout_ms ?? 10min) and nodeTimeoutEscalated
 * does NOT move deadline_ms — so a live overdue node legitimately shows a
 * flat timeout_extensions for up to one full escalate interval (10 minutes
 * on the default config). The freeze window is therefore expressed in
 * ticks: a node is only declared dead once its counter has stayed flat for
 * frozenTicksNeeded(escalateIntervalMs) consecutive sweep ticks — the
 * default 10-minute cadence needs 11 ticks (≈11 minutes), so a live watcher
 * always moves the counter well inside the window, while a dead one (the
 * incident shape: 7.5h frozen) is settled in bounded time.
 */

export interface Interface {
  /** Re-arm the periodic sweep fiber (idempotent; production layers fork it at construction). */
  readonly init: () => Effect.Effect<void>
  /** One scan pass. Exported for deterministic tests: loop it frozenTicksNeeded times to simulate a dead watcher. */
  readonly sweepOnce: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DagSupervisionSweep") {}

export const SWEEP_INTERVAL = "60 seconds"

/**
 * Ticks a flat timeout_extensions counter must persist across before the
 * sweep declares supervision dead: ceil(escalateInterval / sweepInterval) + 1,
 * evaluated against the DEFAULT node timeout (10 min) — the widest cadence a
 * live watcher can legitimately sleep. Nodes configured with shorter
 * timeouts escalate faster, so they are only ever settled later than
 * strictly necessary, never sooner.
 */
export const FROZEN_TICKS_NEEDED = 11

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const dag = yield* Dag.Service
    const promptSvc = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope

    // nodeKey -> {extensions, flatTicks}: the counter value last observed and
    // how many consecutive sweep ticks it has stayed flat while the node was
    // running and overdue. Reset on any counter movement, terminal status, or
    // disappearance from the query.
    const flatStreak = new Map<string, { extensions: number; flatTicks: number }>()

    const sweepOnce = Effect.fn("DagSupervisionSweep.sweepOnce")(function* () {
      const rows = yield* db
        .select({
          workflowId: WorkflowNodeTable.workflow_id,
          nodeId: WorkflowNodeTable.id,
          childSessionId: WorkflowNodeTable.child_session_id,
          extensions: WorkflowNodeTable.timeout_extensions,
        })
        .from(WorkflowNodeTable)
        .where(
          and(
            eq(WorkflowNodeTable.status, "running"),
            sql`${WorkflowNodeTable.deadline_ms} IS NOT NULL AND ${WorkflowNodeTable.deadline_ms} <= ${Date.now()}`,
          ),
        )
        .all()
        .pipe(
          // A store defect must not kill the sweep — the same silent-death
          // class this service exists to eliminate. Degrade to an empty
          // pass and retry next tick (mirror of spawn.ts's R13 hardening).
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("DagSupervisionSweep store query failed — skipping tick", { cause })
              return []
            }),
          ),
        )

      const observed = new Map<string, { extensions: number; flatTicks: number }>()
      for (const row of rows) {
        const key = `${row.workflowId}\0${row.nodeId}`
        const prior = flatStreak.get(key)
        const flatTicks = prior && prior.extensions === row.extensions ? prior.flatTicks + 1 : 0
        observed.set(key, { extensions: row.extensions, flatTicks })
        if (flatTicks < FROZEN_TICKS_NEEDED) continue
        // Frozen across the full window: cancel the (possibly dead) child and
        // settle the node. The nodeFailed guard under the workflow lock
        // serializes any race with a live watcher or another host's sweep.
        if (row.childSessionId) {
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the durable column is typed string|null; the cancel seam brands SessionID.
          yield* promptSvc.cancel(row.childSessionId as never).pipe(Effect.ignore)
        }
        yield* dag
          .nodeFailed(
            row.workflowId,
            row.nodeId,
            `deadline supervision lost (no escalation progress across ${FROZEN_TICKS_NEEDED} sweep ticks) — swept, extensions ${row.extensions}`,
            "timeout",
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DagSupervisionSweep nodeFailed failed", {
                dagID: row.workflowId,
                nodeID: row.nodeId,
                cause,
              }),
            ),
          )
        yield* Effect.logWarning("DagSupervisionSweep settled a node with dead deadline supervision", {
          dagID: row.workflowId,
          nodeID: row.nodeId,
          extensions: row.extensions,
        })
        observed.delete(key)
      }
      // Retain only what is still overdue-running so settled/restarted nodes
      // do not accumulate.
      flatStreak.clear()
      for (const [key, streak] of observed) flatStreak.set(key, streak)
    })

    let sweepFiber: Fiber.Fiber<void> | undefined

    const init = Effect.fn("DagSupervisionSweep.init")(function* () {
      if (sweepFiber) return
      sweepFiber = yield* Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(SWEEP_INTERVAL)
          yield* sweepOnce().pipe(
            // Per-tick guard: any residual defect inside a tick degrades to
            // a logged skip — the loop itself must outlive every failure.
            Effect.catchCause((cause) =>
              Effect.logWarning("DagSupervisionSweep tick failed — retrying next interval", { cause }),
            ),
          )
        }
      }).pipe(Effect.forkIn(scope))
    })

    // AGENTS.md background-loop convention: fork at construction so the sweep
    // survives without any caller remembering to init it.
    yield* init()

    return Service.of({ init, sweepOnce })
  }),
)

/** The bare effect layer — bring your own Database/Dag/SessionPrompt. Tests compose this against their mocks; production uses `defaultLayer`. */
export const layerWithoutDeps = serviceLayer

export const layer = serviceLayer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(Dag.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
)

export const defaultLayer = layer

export const node = LayerNode.make(serviceLayer, [Database.node, Dag.node, SessionPrompt.node])
