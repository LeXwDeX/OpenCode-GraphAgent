/**
 * Drift guard: the projector's event→status from-guards must stay a subset of
 * the declared iron-law transition tables in core/types.ts.
 *
 * The tables (getValidNextNodeStatuses / getValidNextWorkflowStatuses) are the
 * declared state machine enforced by publisher-side guards; the projector's
 * from-lists are a second encoding used as SQL race protection. Historically
 * the two drifted apart silently (e.g. the projector accepted
 * pending→completed which the table forbids). This test welds them together:
 * any edit to one side without the other fails here.
 *
 * Exemptions:
 * - self-transitions (from === to): idempotent re-application of a replayed
 *   event, not a state change.
 * - WorkflowStatusProjection.replanReopen (completed→running): the single
 *   sanctioned exception to terminal irreversibility — additive extend may
 *   reopen a naturally-completed workflow (see dag.ts reopenCompleted).
 */
import { describe, expect, it } from "bun:test"
import { NodeStatusProjection, WorkflowStatusProjection } from "../src/dag/projector"
import {
  getValidNextNodeStatuses,
  getValidNextWorkflowStatuses,
  type NodeStatus,
  type WorkflowStatus,
} from "../src/dag/core/types"

describe("projector from-guards vs declared transition tables", () => {
  it("every node projection guard is a declared transition (or a self-transition)", () => {
    const violations: string[] = []
    for (const [event, projection] of Object.entries(NodeStatusProjection)) {
      for (const from of projection.from) {
        if (from === projection.to) continue
        const allowed = getValidNextNodeStatuses(from as NodeStatus)
        if (!allowed.includes(projection.to as NodeStatus)) {
          violations.push(`${event}: ${from} -> ${projection.to} is not in the declared node table`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it("every workflow projection guard is a declared transition (or the sanctioned reopen)", () => {
    const violations: string[] = []
    for (const [event, projection] of Object.entries(WorkflowStatusProjection)) {
      // The documented terminal-irreversibility exception: additive-extend
      // reopen of a completed workflow. Exempt exactly this entry.
      if (event === "replanReopen") continue
      for (const from of projection.from) {
        if (from === projection.to) continue
        const allowed = getValidNextWorkflowStatuses(from as WorkflowStatus)
        if (!allowed.includes(projection.to as WorkflowStatus)) {
          violations.push(`${event}: ${from} -> ${projection.to} is not in the declared workflow table`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it("keeps the reopen exemption scoped to completed→running only", () => {
    expect(WorkflowStatusProjection.replanReopen.to).toBe("running")
    expect([...WorkflowStatusProjection.replanReopen.from]).toEqual(["completed"])
  })
})

// Note: core/dag/core/transitions.ts (transitionToNodeEvent & friends) is a
// third encoding of the same machine with zero production callers — a
// capability reservoir kept for the event-semantics mapping. It is exercised
// by dag-core.test.ts only and intentionally not welded here.
