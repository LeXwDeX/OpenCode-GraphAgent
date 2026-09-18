// Unit tests for the consumer-only DAG hold decision rule (issue 614).
// Table-driven over the busy/idle event orderings the run loop feeds the
// wrapper: each row is one CLI run's poll sequence with the expected idle
// decisions. Real-CLI lifecycle coverage lives in run-dag-hold-process.test.ts.
import { describe, expect, test } from "bun:test"
import { DagHold } from "../../../src/cli/cmd/run/dag-hold"

type Snapshot = readonly DagHold.DagWorkflowSnapshot[]

type Step =
  | { readonly event: "busy"; readonly snapshot?: Snapshot; readonly fail?: "reject" | "undefined" }
  | {
      readonly event: "idle"
      readonly snapshot?: Snapshot
      readonly fail?: "reject" | "undefined"
      readonly expect: DagHold.DagHoldDecision
    }

function drive(steps: readonly Step[]): Promise<DagHold.DagHoldDecision[]> {
  let cursor = 0
  const poll = (): Promise<Snapshot | undefined> => {
    const step = steps[cursor]
    cursor += 1
    if (!step || step.fail === "reject") return Promise.reject(new Error("poll boom"))
    if (step.fail === "undefined") return Promise.resolve(undefined)
    return Promise.resolve(step.snapshot ?? [])
  }
  const hold = DagHold.createDagHold(poll)
  const decisions: DagHold.DagHoldDecision[] = []
  return (async () => {
    for (const step of steps) {
      if (step.event === "busy") {
        await hold.onBusy()
        continue
      }
      decisions.push(await hold.onIdle())
    }
    return decisions
  })()
}

const wf = (id: string, status: string): DagHold.DagWorkflowSnapshot => ({ id, status })

describe("dag hold decision rule (issue 614)", () => {
  test("table: every busy/idle ordering resolves to the adjudicated hold/break sequence", async () => {
    const table: ReadonlyArray<{ readonly name: string; readonly steps: readonly Step[] }> = [
      {
        // Plain prompt, no workflow ever: exit at the first idle, unchanged.
        name: "no-workflow breaks immediately",
        steps: [{ event: "idle", snapshot: [], expect: "break" }],
      },
      {
        // Workflow created in turn one, still active at the first idle.
        name: "running holds, breaks after the wake turn",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "running")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "break" },
        ],
      },
      {
        // Workflow completes during the busy phase after being observed active:
        // the wake is still owed, so the quiescent idle must hold.
        name: "active-then-quiescent within one turn holds for the owed wake",
        steps: [
          { event: "busy", snapshot: [wf("W1", "running")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "break" },
        ],
      },
      {
        // A session turn re-emits busy at every model step. The workflow is
        // observed running at one step and terminal at the next; the repeated
        // in-turn busy must NOT reset the latch (regression: the reset-on-every-
        // busy variant broke at the idle and lost the wake).
        name: "repeated in-turn busy events keep the active latch",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "busy", snapshot: [wf("W1", "running")] },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "break" },
        ],
      },
      {
        // A workflow adopted as paused and resumed mid-turn (paused → running
        // → completed between two polls of the SAME turn): the running
        // observation latches busyActive and the idle holds for the wake.
        name: "resumed adoption within one turn latches on the running step",
        steps: [
          { event: "busy", snapshot: [wf("W1", "paused")] },
          { event: "busy", snapshot: [wf("W1", "running")] },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "break" },
        ],
      },
      {
        // Workflow terminalizes inside turn one before any poll saw it: the
        // first-seen id keeps the loop alive for its wake turn.
        name: "terminal within turn one holds once, then breaks",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "failed")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "failed")] },
          { event: "idle", snapshot: [wf("W1", "failed")], expect: "break" },
        ],
      },
      {
        // --continue adoption: the session already has a live workflow when
        // the run starts; discovered at the busy transition, held through
        // completion.
        name: "adopted running workflow holds to completion",
        steps: [
          { event: "busy", snapshot: [wf("W1", "running")] },
          { event: "idle", snapshot: [wf("W1", "running")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "break" },
        ],
      },
      {
        // Chained DAG: a second workflow started during the wake turn is a
        // first-seen id at that turn's idle and holds for its own wake.
        name: "chained DAG during a wake turn holds through the chain",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "running")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed"), wf("W2", "running")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed"), wf("W2", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed"), wf("W2", "completed")], expect: "break" },
        ],
      },
      {
        // Paused workflows are not active: after the pause wake turn the loop
        // exits as it did before the hold existed.
        name: "paused holds once for the pause wake, then breaks as today",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "paused")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "paused")] },
          { event: "idle", snapshot: [wf("W1", "paused")], expect: "break" },
        ],
      },
      {
        name: "stepping breaks once known",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "stepping")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "stepping")] },
          { event: "idle", snapshot: [wf("W1", "stepping")], expect: "break" },
        ],
      },
      {
        // Every terminal status behaves like completed.
        name: "cancelled and archived hold once when first seen, then break",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "cancelled"), wf("W2", "archived")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "cancelled"), wf("W2", "archived")] },
          { event: "idle", snapshot: [wf("W1", "cancelled"), wf("W2", "archived")], expect: "break" },
        ],
      },
      {
        // A pending workflow (queued children, not yet running) is active.
        name: "pending holds",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "pending")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "running")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "break" },
        ],
      },
    ]

    for (const row of table) {
      const decisions = await drive(row.steps)
      const expected = row.steps.flatMap((step) => (step.event === "idle" ? [step.expect] : []))
      expect(decisions).toEqual(expected)
    }
  })

  test("poll failure at idle breaks silently (rejected poll)", async () => {
    const decisions = await drive([{ event: "idle", fail: "reject", expect: "break" }])
    expect(decisions).toEqual(["break"])
  })

  test("poll failure at idle breaks silently (undefined poll result)", async () => {
    const decisions = await drive([{ event: "idle", fail: "undefined", expect: "break" }])
    expect(decisions).toEqual(["break"])
  })

  test("poll failure while busy leaves state untouched and the run still exits cleanly", async () => {
    const decisions = await drive([
      { event: "busy", fail: "reject" },
      { event: "idle", snapshot: [], expect: "break" },
    ])
    expect(decisions).toEqual(["break"])
  })

  test("pure helpers: active statuses, turn reset, and first-seen id evaluation order", () => {
    expect(DagHold.isDagActiveStatus("pending")).toBe(true)
    expect(DagHold.isDagActiveStatus("running")).toBe(true)
    for (const status of ["paused", "stepping", "completed", "failed", "cancelled", "archived"]) {
      expect(DagHold.isDagActiveStatus(status)).toBe(false)
    }

    const state = DagHold.initialDagHoldState()
    expect(DagHold.applyDagHoldSnapshot(state, [wf("W1", "completed")])).toBe("hold")
    expect(state.busyIds.has("W1")).toBe(true)
    // The id folded by the previous snapshot is now known, so the same
    // quiescent snapshot breaks — evaluation happens against the pre-update
    // set, not the post-fold one.
    expect(DagHold.applyDagHoldSnapshot(state, [wf("W1", "completed")])).toBe("break")
    // Active observation latches busyActive across a whole turn...
    DagHold.observeDagHoldBusy(state, [wf("W2", "running")])
    expect(state.busyActive).toBe(true)
    // ...repeated in-turn busies keep the latch (only an idle ends the turn)...
    DagHold.observeDagHoldBusy(state, [wf("W2", "completed")])
    expect(state.busyActive).toBe(true)
    DagHold.observeDagHoldBusy(state, [wf("W2", "completed")])
    expect(state.busyActive).toBe(true)
    // ...so the quiescent idle still holds for the owed wake.
    expect(DagHold.applyDagHoldSnapshot(state, [wf("W2", "completed")])).toBe("hold")
    // The next turn's first busy is the idle→busy boundary and does reset it.
    DagHold.observeDagHoldBusy(state, [wf("W1", "completed"), wf("W2", "completed")])
    expect(state.busyActive).toBe(false)
    expect(DagHold.applyDagHoldSnapshot(state, [wf("W1", "completed"), wf("W2", "completed")])).toBe("break")
  })
})
