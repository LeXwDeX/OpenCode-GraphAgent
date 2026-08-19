// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagSupervisionSweep from "./supervision-sweep"

import { Cause, Context, Effect, Fiber, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowNodeTable } from "@opencode-ai/core/dag/sql"
import { and, eq, sql } from "drizzle-orm"
import { Dag, parseWorkflowConfig } from "@/dag/dag"
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
 * row it can read. Same-host races (a live watcher, the DagLoop) are
 * serialized by the workflow's in-process lock; a second host sharing the
 * DB is handled by the durable guardNode status read plus the projector's
 * conditional UPDATE (only the first NodeFailed folds a non-terminal row) —
 * double settles collapse to one.
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
const SWEEP_INTERVAL_MS = 60_000

/**
 * Flat ticks before declaring supervision dead, derived from the node's own
 * escalation cadence: a LIVE watcher escalates every
 * escalateIntervalMs == max(1s, timeout_ms ?? 10min) and never moves
 * deadline_ms, so its counter can legitimately stay flat for up to one full
 * interval. Requiring ceil(interval / sweep interval) + 1 consecutive flat
 * ticks means a live watcher — at ANY configured timeout, including the
 * doc-recommended 30-minute verifier timeouts — always moves the counter
 * inside the window, while a dead one (the incident shape: hours frozen) is
 * settled in bounded time. The config lookup happens once a node has been
 * overdue-flat for at least one tick, so healthy graphs pay nothing.
 */
export const frozenTicksNeeded = (escalateIntervalMs: number) =>
  Math.ceil(Math.max(escalateIntervalMs, 1_000) / SWEEP_INTERVAL_MS) + 1

/**
 * The node's escalation cadence derived from a persisted config row. Pure —
 * exported for unit tests. parseWorkflowConfig is the repo's defensive
 * parser: malformed JSON or shape-divergent rows return undefined instead of
 * throwing, and every degrade path lands on the DEFAULT cadence (the widest
 * guaranteed-safe window) — a single corrupt row must never defect the sweep.
 */
export const escalateIntervalFromConfig = (raw: string | undefined, nodeId: string) => {
  const node = raw === undefined ? undefined : parseWorkflowConfig(raw)?.nodes.find((n) => n.id === nodeId)
  const timeoutMs = node?.worker_config?.timeout_ms
  return Math.max(1_000, typeof timeoutMs === "number" ? timeoutMs : Dag.DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs)
}

/**
 * An upper bound on the cadence the LIVE watcher actually runs at,
 * back-derived from durable columns. deadline_ms is only ever written as
 * `grant time + timeout_ms` — at spawn (started_at + T0) and at each
 * deadline extension (now + Ti) — while escalations move only the counter,
 * never the deadline. The granted total (deadline − started_at) is therefore
 * the sum of the initial grant plus every extension grant, which is always
 * ≥ the LAST grant, and the last grant's timeout IS the live watcher's
 * cadence (a re-time replaces the watcher at the new timeout). Issue #342:
 * replan can lower a running node's persisted timeout_ms while the A1/Q2
 * re-time gate deliberately keeps the old watcher on its old (longer)
 * cadence — a config-only window would then be shorter than the live
 * watcher's cycle and sweep a healthy node. Taking the max with the config
 * cadence covers both shapes: re-timed watchers match the config (the
 * durable value merely over-estimates by the accumulated grants, delaying —
 * never causing — a settle), gate-skipped ones are caught by the durable
 * bound. Returns 0 when the columns are missing (legacy rows) so the config
 * value decides alone.
 */
export const escalateIntervalDurable = (
  deadlineMs: number | null | undefined,
  startedAt: number | null | undefined,
) => {
  if (deadlineMs == null || startedAt == null) return 0
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(startedAt)) return 0
  const granted = deadlineMs - startedAt
  if (granted <= 0) return 0
  return Math.max(1_000, granted)
}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const store = yield* DagStore.Service
    const dag = yield* Dag.Service
    const promptSvc = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope

    // nodeKey -> {extensions, flatTicks}: the counter value last observed and
    // how many consecutive sweep ticks it has stayed flat while the node was
    // running and overdue. Reset on any counter movement, terminal status, or
    // disappearance from the query.
    const flatStreak = new Map<string, { extensions: number; flatTicks: number }>()

    // The node's escalation cadence, from the workflow's persisted config —
    // the same source spawn.ts derived the watcher's escalateIntervalMs from.
    // Only nodes already flat for a tick pay this lookup; a store read
    // failure degrades to the DEFAULT cadence (the widest guaranteed-safe
    // window).
    const escalateIntervalFor = Effect.fnUntraced(function* (workflowId: string, nodeId: string) {
      const wf = yield* store.getWorkflow(workflowId).pipe(
        Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined))),
      )
      return escalateIntervalFromConfig(wf?.config, nodeId)
    })

    const sweepOnce = Effect.fn("DagSupervisionSweep.sweepOnce")(function* () {
      const rows = yield* db
        .select({
          workflowId: WorkflowNodeTable.workflow_id,
          nodeId: WorkflowNodeTable.id,
          childSessionId: WorkflowNodeTable.child_session_id,
          extensions: WorkflowNodeTable.timeout_extensions,
          deadlineMs: WorkflowNodeTable.deadline_ms,
          startedAt: WorkflowNodeTable.started_at,
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
          // Interrupts (scope disposal) still propagate — the repo's
          // background-loop discipline.
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.gen(function* () {
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
        // Only nodes already flat for a tick pay the config lookup.
        if (flatTicks < 1) continue
        const escalateIntervalMs = yield* escalateIntervalFor(row.workflowId, row.nodeId)
        // #342: the window must cover the LIVE watcher's actual cadence, not
        // just the current config's — replan may have lowered the persisted
        // timeout while the re-time gate kept the old watcher.
        const windowIntervalMs = Math.max(
          escalateIntervalMs,
          escalateIntervalDurable(row.deadlineMs, row.startedAt),
        )
        if (flatTicks < frozenTicksNeeded(windowIntervalMs)) continue
        // Frozen across the full window: cancel the (possibly dead) child and
        // settle the node. Same-host races (a live watcher) are serialized by
        // the workflow's in-process lock; another host's sweep is collapsed
        // by the durable terminal-status guard — either way at most one
        // settle lands.
        if (row.childSessionId) {
          // Best-effort cancel, recovered at CAUSE level: the sweep's layer
          // context has no ambient InstanceRef, so a real SessionPrompt.cancel
          // dies at InstanceState.context ("InstanceRef not provided") — and
          // cancel's channel is E=never, where Effect.ignore recovers nothing.
          // In the incident shape (instance disposed) the child fiber died
          // with the scope, so a skipped cancel is also the correct outcome;
          // the durable settle below is the source of truth either way.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the durable column is typed string|null; the cancel seam brands SessionID.
          yield* promptSvc.cancel(row.childSessionId as never).pipe(
            Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void)),
          )
        }
        const settled = yield* dag
          .nodeFailed(
            row.workflowId,
            row.nodeId,
            `deadline supervision lost (no escalation progress across ${flatTicks} sweep ticks, escalate cadence ${escalateIntervalMs}ms) — swept, extensions ${row.extensions}`,
            "timeout",
          )
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.gen(function* () {
                    yield* Effect.logWarning("DagSupervisionSweep nodeFailed failed — retrying next tick", {
                      dagID: row.workflowId,
                      nodeID: row.nodeId,
                      cause,
                    })
                    return false
                  }),
            ),
          )
        // On a failed settle keep the streak so the next tick retries
        // immediately instead of deferring by a full freeze window.
        if (!settled) continue
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
            // Interrupts (scope disposal) still exit the loop.
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("DagSupervisionSweep tick failed — retrying next interval", { cause }),
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
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(Dag.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
)

export const defaultLayer = layer

export const node = LayerNode.make(serviceLayer, [Database.node, DagStore.node, Dag.node, SessionPrompt.node])
