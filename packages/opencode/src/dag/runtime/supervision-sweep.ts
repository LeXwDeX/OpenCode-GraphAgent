// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagSupervisionSweep from "./supervision-sweep"

import { Context, Effect, Fiber, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowNodeTable } from "@opencode-ai/core/dag/sql"
import { and, eq, sql } from "drizzle-orm"
import { Dag } from "@/dag/dag"
import { DagLocation } from "@/dag/location"
import { InstanceState } from "@/effect/instance-state"
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
 * InstanceState scope: its repeating fiber is forked into the LAYER scope at
 * construction (per AGENTS.md's background-loop convention) and lives for
 * the process lifetime. Each tick looks for the frozen signature — a
 * `running` node whose deadline has passed and whose `timeout_extensions`
 * did not move between two consecutive ticks (a live watcher escalates on
 * its interval, so a frozen counter across a full tick window means
 * supervision is gone). On detection it cancels the child session and fails
 * the node durably ("timeout") — the same terminal semantics the watcher's
 * cap enforcement would have applied.
 *
 * False-positive safety: a node whose watcher is alive always shows counter
 * movement across two ticks (escalateIntervalMs == max(1s, timeoutMs), far
 * below the sweep interval); a node that terminalized races safely — the
 * nodeFailed guard rejects the stale write.
 */

export interface Interface {
  /** Re-arm the periodic sweep fiber (idempotent). Production layers fork it at construction; init exists for entry points that prefer explicit control. */
  readonly init: () => Effect.Effect<void>
  /** One scan pass. Exported for deterministic tests: call twice with the freeze window in between to simulate a dead watcher. */
  readonly sweepOnce: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DagSupervisionSweep") {}

export const SWEEP_INTERVAL = "60 seconds"

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const dag = yield* Dag.Service
    const promptSvc = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope

    // nodeKey -> timeout_extensions observed at the previous tick. A running,
    // deadline-overdue node whose counter did not advance across a tick is
    // frozen (supervision dead).
    const lastSeen = new Map<string, number>()
    let sweepFiber: Fiber.Fiber<void> | undefined

    const sweepOnce = Effect.fn("DagSupervisionSweep.sweepOnce")(function* () {
      const rows = yield* db
        .select({
          workflowId: WorkflowNodeTable.workflow_id,
          nodeId: WorkflowNodeTable.id,
          childSessionId: WorkflowNodeTable.child_session_id,
          deadlineMs: WorkflowNodeTable.deadline_ms,
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
        .pipe(Effect.orDie)

      const observed = new Map<string, number>()
      for (const row of rows) {
        const key = `${row.workflowId}\0${row.nodeId}`
        observed.set(key, row.extensions)
        const previous = lastSeen.get(key)
        if (previous === undefined) continue
        if (previous !== row.extensions) continue // counter moved — watcher alive
        // Frozen across a full tick: confirm this instance still owns the
        // workflow before writing (a repainted or migrated identity belongs
        // to whichever instance now owns it).
        if (!(yield* DagLocation.ownsWorkflow(row.workflowId, yield* InstanceState.directory))) continue
        if (row.childSessionId) {
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the durable column is typed string|null; the cancel seam brands SessionID.
          yield* promptSvc.cancel(row.childSessionId as never).pipe(Effect.ignore)
        }
        yield* dag
          .nodeFailed(
            row.workflowId,
            row.nodeId,
            `deadline supervision lost (no escalation progress across sweep window) — swept, extensions ${row.extensions}`,
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
      lastSeen.clear()
      for (const [key, extensions] of observed) lastSeen.set(key, extensions)
    })

    const init = Effect.fn("DagSupervisionSweep.init")(function* () {
      if (sweepFiber) return
      sweepFiber = yield* Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(SWEEP_INTERVAL)
          yield* sweepOnce()
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
