// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

// Consumer-only DAG hold for the non-interactive `opencode run` loop (issue 614).
//
// Today the loop breaks on the FIRST session.status=idle of the target session,
// so a workflow started in that turn keeps running server-side while the CLI
// exits and the eventual wake reply is silently lost. The durable dag.* events
// are not on the client wire and `wake_reported` is not part of the
// dag.bySession DTO, so the consumer cannot subscribe to completion — it can
// only poll. This module is that poll: a pure three-condition break rule plus a
// thin wrapper the run loop calls on the busy/idle transitions it already
// observes.
//
// A session turn is NOT one busy event: the prompt loop re-emits
// session.status=busy at the top of every model step, so the wrapper sees N
// busy events per turn. Per-turn state therefore resets only on the FIRST busy
// after an idle (the true idle→busy transition); later busies within the same
// turn keep sampling the workflow snapshot and can only ever strengthen the
// latch — never clear it mid-turn.
//
// Tracked state:
//   busyIds    — every workflow id observed by any poll so far (accumulates)
//   busyActive — some poll observed a workflow in {pending, running} since the
//                last idle→busy transition
//
// Break on idle iff ALL hold:
//   1. poll(now) shows no workflow in {pending, running}
//   2. busyActive === false (active work seen this turn means a wake is owed
//      even if the poll is already quiescent)
//   3. every id in poll(now) was already known (a first-seen workflow id means
//      a wake for it may still be in flight — covers workflows that
//      terminalize within turn one and chained DAGs started during a wake turn)
//
// Degradation is deliberately silent and matches pre-614 behavior:
//   - a poll failure at idle breaks the loop (today's exit, no error surfaced)
//   - a poll failure while busy leaves the state untouched
// Paused and stepping workflows are not active statuses, so they never hold the
// loop open by themselves — the CLI exits as it does today once quiescent and
// known. There is no timer and no reconnect: an engine stall is bounded by the
// engine watchdog, and a visible hang is accepted over silent wake loss.

import type { OpencodeClient } from "@opencode-ai/sdk/v2"

export type DagWorkflowSnapshot = {
  readonly id: string
  readonly status: string
}

export type DagHoldDecision = "hold" | "break"

export type DagHoldState = {
  /** Workflow ids observed by any poll so far (accumulates across turns). */
  readonly busyIds: Set<string>
  /** Active work observed since the last idle→busy transition. */
  busyActive: boolean
  /** True between the first busy of a turn and the turn's idle event. */
  inTurn: boolean
}

/** Terminal-adjacent statuses that do not keep the loop alive. The complement
 * of the workflow terminal set lives in core; the hold only needs its own
 * active pair. */
export function isDagActiveStatus(status: string): boolean {
  return status === "pending" || status === "running"
}

export function initialDagHoldState(): DagHoldState {
  return { busyIds: new Set(), busyActive: false, inTurn: false }
}

function foldSnapshot(state: DagHoldState, snapshot: readonly DagWorkflowSnapshot[]): void {
  for (const workflow of snapshot) state.busyIds.add(workflow.id)
  if (snapshot.some((workflow) => isDagActiveStatus(workflow.status))) state.busyActive = true
}

/** A busy event of the target session. Only the FIRST busy after an idle is a
 * turn boundary; repeated busies within the turn must not clear the latch. */
export function observeDagHoldBusy(state: DagHoldState, snapshot: readonly DagWorkflowSnapshot[]): void {
  if (!state.inTurn) {
    state.inTurn = true
    state.busyActive = false
  }
  foldSnapshot(state, snapshot)
}

/** The idle event of the target session: evaluate the break rule against the
 * PRE-update state, then fold the snapshot in. A workflow id that appears for
 * the first time in this snapshot must read as unknown even though the fold
 * adds it right after. */
export function applyDagHoldSnapshot(state: DagHoldState, snapshot: readonly DagWorkflowSnapshot[]): DagHoldDecision {
  const active = snapshot.some((workflow) => isDagActiveStatus(workflow.status))
  const known = snapshot.every((workflow) => state.busyIds.has(workflow.id))
  const decision: DagHoldDecision = !active && !state.busyActive && known ? "break" : "hold"
  state.inTurn = false
  foldSnapshot(state, snapshot)
  return decision
}

export type DagHoldPoll = () => Promise<readonly DagWorkflowSnapshot[] | undefined>

export type DagHold = {
  /** session.status=busy for the target session: sample the workflow snapshot
   * (failures ignored) and latch per-turn active state. */
  readonly onBusy: () => Promise<void>
  /** session.status=idle for the target session: poll and decide. A failed
   * poll breaks — exactly the pre-614 exit, silently. */
  readonly onIdle: () => Promise<DagHoldDecision>
}

export function createDagHold(poll: DagHoldPoll): DagHold {
  const state = initialDagHoldState()
  return {
    onBusy: async () => {
      const snapshot = await poll().catch(() => undefined)
      if (snapshot) observeDagHoldBusy(state, snapshot)
    },
    onIdle: async () => {
      const snapshot = await poll().catch(() => undefined)
      if (!snapshot) return "break"
      return applyDagHoldSnapshot(state, snapshot)
    },
  }
}

/** Poll implementation over the in-process SDK client (GET /dag/session/:id —
 * session-scoped, project-ownership enforced server-side). Any failure maps to
 * undefined so the wrapper degrades silently. */
export async function dagWorkflowsBySession(
  client: OpencodeClient,
  sessionID: string,
): Promise<readonly DagWorkflowSnapshot[] | undefined> {
  const response = await client.dag.bySession({ sessionID })
  if (response.error) return undefined
  return (response.data ?? []).map((workflow) => ({ id: workflow.id, status: workflow.status }))
}

export * as DagHold from "./dag-hold"
