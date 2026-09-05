// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DAG scheduling core — replan merge planning (D11, simplified model).
 *
 * Pure: given the current graph state and a subsequent YAML fragment, produce
 * a structured merge plan the runtime executes atomically (pause → apply plan
 * → resume). No I/O.
 *
 * This is a REWRITE of the dag-iron-laws replan functions. The old 5 functions
 * enforced an array-patch protocol (add_nodes/remove_nodes/update_nodes arrays)
 * that is incompatible with the simplified "replan = write a subsequent YAML
 * fragment" model. The new model:
 *
 * - terminal nodes (done/cancelled/failed) in the fragment → IGNORED (iron law #2)
 * - running nodes:
 *   - absent from fragment → kept unchanged (let finish)
 *   - present, no marker   → classified as replace; the host must first prove
 *                            the definition is equivalent or the update is safe
 *   - restart: true        → pause + discard child session + re-spawn with fragment's def
 *   - cancel: true         → cancelled; downstream becomes orphan (auto-failed via cascade)
 * - queued/paused nodes:
 *   - absent from fragment → cancelled (superseded)
 *   - present               → classified as replace; the host must first prove
 *                             captured execution fields are unchanged
 * - pending nodes:
 *   - absent from fragment → cancelled (superseded)
 *   - present               → replaced with fragment's def
 * - new ids (not in old graph) → added
 *
 * After merge the full graph MUST be acyclic; validation fails otherwise.
 * This config-free planner cannot compare complete node definitions. Callers
 * must validate execution-field changes before applying the returned plan.
 */

import { CycleError, DependencyGraph } from "./graph"
import { isNodeTerminalStatus, NodeStatus } from "./types"

/** A node as it appears in a replan fragment. */
export interface ReplanNodeInput {
  id: string
  depends_on: string[]
  /** Marker: re-spawn this running node's child session with the fragment's def. */
  restart?: boolean
  /** Marker: cancel this non-terminal node; downstream is auto-failed via cascade. */
  cancel?: boolean
}

/** A node's current state in the graph when replan is invoked. */
export interface CurrentNodeState {
  id: string
  status: NodeStatus
  depends_on: string[]
}

/** The structured plan returned by {@link planReplan}. */
export interface ReplanMergePlan {
  /** Non-empty means the replan is REJECTED; the runtime must not apply it. */
  errors: string[]
  /** Node ids to cancel (superseded pending/queued/paused + explicit cancel). */
  cancel: string[]
  /** Node ids to restart (running-with-restart); def comes from the fragment. */
  restart: string[]
  /** Non-terminal nodes to replace after the host validates their definitions. */
  replace: string[]
  /** New node ids to add. */
  add: string[]
  /** Terminal ids that appeared in the fragment (no-op, recorded for audit). */
  ignore: string[]
  /** The post-merge graph (for the runtime to use after applying the plan). */
  mergedGraph: DependencyGraph
}

/**
 * Plan a replan: classify every node, validate the result, build the merged graph.
 *
 * @param current  snapshot of the current graph (ids + statuses + deps)
 * @param fragment the subsequent YAML fragment the agent submitted
 * @returns a merge plan; check `.errors` first — if non-empty, reject.
 *
 * @example
 * ```ts
 * const plan = planReplan(currentGraph, fragment)
 * if (plan.errors.length > 0) return rejectReplan(plan.errors)
 * // runtime applies plan.cancel / plan.restart / plan.replace / plan.add
 * ```
 */
export function planReplan(
  current: { nodes: CurrentNodeState[] },
  fragment: { nodes: ReplanNodeInput[] },
): ReplanMergePlan {
  const errors: string[] = []
  const cancel: string[] = []
  const restart: string[] = []
  const replace: string[] = []
  const add: string[] = []
  const ignore: string[] = []

  const currentStateById = new Map(current.nodes.map((n) => [n.id, n]))
  const fragmentNodeById = new Map(fragment.nodes.map((n) => [n.id, n]))
  const fragmentIds = new Set(fragment.nodes.map((n) => n.id))

  // 1. Validate fragment-internal consistency: duplicate ids, restart/cancel
  //    mutual exclusion, and restart/cancel on ids that don't exist in the
  //    current graph (those are nonsensical — a new id can't be restarted or
  //    cancelled, only added).
  const fragmentSeen = new Set<string>()
  for (const fragNode of fragment.nodes) {
    if (fragmentSeen.has(fragNode.id)) {
      errors.push(`Fragment contains duplicate node id "${fragNode.id}"`)
    }
    fragmentSeen.add(fragNode.id)
  }
  for (const fragNode of fragment.nodes) {
    if (fragNode.restart && fragNode.cancel) {
      errors.push(`Node "${fragNode.id}" declares both restart and cancel — pick one`)
    }
    const existing = currentStateById.get(fragNode.id)
    if (fragNode.restart && !existing) {
      errors.push(`Node "${fragNode.id}" declares restart but is not in the current graph (new nodes are added, not restarted)`)
    }
    if (fragNode.cancel && !existing) {
      errors.push(`Node "${fragNode.id}" declares cancel but is not in the current graph (new nodes are added, not cancelled)`)
    }
    if (existing && fragNode.restart && existing.status !== NodeStatus.RUNNING) {
      errors.push(
        isNodeTerminalStatus(existing.status)
          ? `Node "${fragNode.id}" declares restart but is terminal (${existing.status}) — terminal nodes are immutable; add a replacement node under a new id instead`
          : `Node "${fragNode.id}" declares restart but is ${existing.status} (restart is only valid on running nodes; include a ${existing.status} node without restart to replace its definition)`,
      )
    }
    if (existing && fragNode.cancel && isNodeTerminalStatus(existing.status)) {
      errors.push(`Node "${fragNode.id}" declares cancel but is already terminal (${existing.status})`)
    }
  }

  // 2. Validate fragment depends_on references: each must resolve to a node that
  //    exists in EITHER the current graph OR the fragment (a fragment node may
  //    depend on another fragment node or on a surviving current node).
  const survivingIds = new Set<string>()
  for (const n of current.nodes) {
    // A current node survives unless it's pending-and-not-in-fragment or cancelled.
    const frag = fragmentNodeById.get(n.id)
    if (frag?.cancel) continue // explicitly cancelled
    if (isNodeTerminalStatus(n.status)) {
      survivingIds.add(n.id) // terminal survives (immutable)
      continue
    }
    if (n.status === NodeStatus.PENDING && !fragmentIds.has(n.id)) continue // superseded
    survivingIds.add(n.id)
  }
  for (const fragNode of fragment.nodes) {
    const existing = currentStateById.get(fragNode.id)
    if (existing && isNodeTerminalStatus(existing.status)) continue // ignored
    if (fragNode.cancel) continue
    survivingIds.add(fragNode.id) // fragment nodes survive (added/replaced/restarted)
  }
  for (const fragNode of fragment.nodes) {
    const existing = currentStateById.get(fragNode.id)
    if (existing && isNodeTerminalStatus(existing.status)) continue // ignored, skip ref check
    if (fragNode.cancel) continue
    for (const depId of fragNode.depends_on) {
      if (!survivingIds.has(depId)) {
        errors.push(
          `Node "${fragNode.id}" depends on "${depId}" which is not present after merge (the dep was cancelled, superseded, or never existed)`,
        )
      }
    }
  }

  if (errors.length > 0) {
    return { errors, cancel, restart, replace, add, ignore, mergedGraph: new DependencyGraph() }
  }

  // 3. Build the merged graph and check it's acyclic. The merged graph contains
  //    every surviving node with its POST-merge dependencies.
  const mergedGraph = new DependencyGraph()
  for (const id of survivingIds) mergedGraph.addNode(id)

  // Apply edges: terminal + running-unchanged nodes keep their current deps;
  // pending-replaced + added + restarted nodes take the fragment's deps.
  // addEdge throws CycleError on a cycle — catch it and report as a validation
  // error rather than propagating (replan rejection, not a crash).
  const tryAddEdge = (from: string, to: string) => {
    try {
      if (mergedGraph.hasNode(from) && mergedGraph.hasNode(to)) mergedGraph.addEdge(from, to)
    } catch (e) {
      if (e instanceof CycleError) {
        errors.push(`Merged graph contains a cycle: ${e.cycle.join(" -> ")}`)
        return
      }
      throw e
    }
  }
  for (const n of current.nodes) {
    if (!survivingIds.has(n.id)) continue
    const frag = fragmentNodeById.get(n.id)
    // P1a: the CHECK graph must equal the proposed post-merge graph. A running
    // node present without a restart marker is classified as replaced, so it
    // takes the fragment's deps here. The host rejects changed admitted deps
    // before applying this plan; keeping the proposed edge here also makes this
    // config-free planner safe for every caller. Terminal nodes are immutable.
    const deps = frag && !isNodeTerminalStatus(n.status) ? frag.depends_on : n.depends_on
    for (const depId of deps) tryAddEdge(n.id, depId)
  }
  for (const fragNode of fragment.nodes) {
    if (currentStateById.has(fragNode.id)) continue // handled above
    for (const depId of fragNode.depends_on) tryAddEdge(fragNode.id, depId)
  }

  if (errors.length > 0) {
    return { errors, cancel, restart, replace, add, ignore, mergedGraph }
  }

  // Defensive: addEdge's wouldCreateCycle pre-check catches direct cycles, but
  // a multi-edge insertion could still leave a cycle if edges were added in an
  // order that bypassed the pre-check. Verify explicitly.
  if (mergedGraph.hasCycle()) {
    const cycle = mergedGraph.findCycles()[0] ?? []
    errors.push(`Merged graph contains a cycle: ${cycle.join(" -> ")}`)
    return { errors, cancel, restart, replace, add, ignore, mergedGraph }
  }

  // 4. Classify each node into the plan buckets.
  for (const n of current.nodes) {
    const frag = fragmentNodeById.get(n.id)
    if (frag?.cancel) {
      cancel.push(n.id)
      continue
    }
    if (isNodeTerminalStatus(n.status)) {
      if (frag) ignore.push(n.id)
      continue
    }
    if (n.status === NodeStatus.RUNNING) {
      if (frag?.restart) {
        restart.push(n.id)
        continue
      }
      // The host must prevalidate this replacement. Dag._replan admits only an
      // equivalent definition or its explicit running-time timeout update.
      if (frag) replace.push(n.id)
      continue
    }
    if (n.status === NodeStatus.PENDING) {
      if (frag) replace.push(n.id)
      else cancel.push(n.id) // superseded
      continue
    }
    // QUEUED / PAUSED: treated like pending for replan purposes.
    if (frag) replace.push(n.id)
    else cancel.push(n.id)
  }
  for (const fragNode of fragment.nodes) {
    if (!currentStateById.has(fragNode.id)) add.push(fragNode.id)
  }

  return { errors, cancel, restart, replace, add, ignore, mergedGraph }
}
