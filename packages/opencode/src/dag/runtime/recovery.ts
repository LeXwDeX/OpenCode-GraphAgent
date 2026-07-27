/**
 * DAG crash recovery — EventV2-driven, no separate recovery table/scan.
 *
 * A child Session's durable state can recover an already-settled result, but it
 * cannot prove that the current process owns provider execution. On startup,
 * every node left `running` by an unclean shutdown is therefore reconciled to a
 * DAG terminal event before its WorkflowRuntime is rebuilt.
 *
 * This is NOT a startup-blocking scan (unlike the old recoverOrphanedWorkflows).
 * It runs lazily when a workflow is first accessed, and only touches workflows
 * that have running nodes.
 *
 * `ownershipLost` counts nodes whose failure was INVENTED by reconciliation
 * (no durable proof of the child's outcome: session missing, still active, or
 * unknown), as opposed to failures read from durable child state. The caller
 * uses it to pause the workflow instead of letting the scheduler cascade skips
 * and terminalize on fabricated evidence (P2-2 recovery-pause).
 */

import { Effect, Clock } from "effect"
import { Dag } from "../dag"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import type { DagStore } from "@opencode-ai/core/dag/store"

export function reconcileWorkflow(
  dagID: string,
  checkSessionStatus: (childSessionID: string) => Effect.Effect<"active" | "completed" | "failed" | "unknown", Error>,
  cancelSession?: (sessionID: string) => Effect.Effect<void, Error>,
  workflowConfig?: { nodes: { id: string; output_schema?: Record<string, unknown> }[] } | undefined,
): Effect.Effect<{ reconciled: number; ownershipLost: number }, Error, Dag.Service> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const nodes = yield* dag.store.getNodes(dagID)
    let reconciled = 0
    let ownershipLost = 0

    for (const node of nodes) {
      // Pending nodes have not been admitted to an execution attempt yet. This
      // includes ordinary dependency-blocked work and restart-orphans; both are
      // left for spawnReady to schedule after runtime reconstruction.
      // A restart-orphan (pending + stale childSessionId) must have its old
      // child session cancelled here, since spawnReady may never revisit it if
      // the workflow is about to become terminal.
      if (node.status === "pending") {
        if (node.childSessionId && cancelSession) {
          yield* cancelSession(node.childSessionId).pipe(Effect.catch(() => Effect.void))
        }
        continue
      }
      if (node.status !== "running") continue
      if (!node.childSessionId) {
        // Crash landed between admission and session creation — no durable
        // outcome exists, so this is an invented failure like ownership loss.
        ownershipLost++
        yield* dag.nodeFailed(dagID, node.id, "node was running but had no child session on recovery", "exec_failed")
        reconciled++
        continue
      }

      const sessionStatus = yield* checkSessionStatus(node.childSessionId).pipe(
        Effect.catch(() => Effect.succeed("unknown" as const)),
      )

      if (sessionStatus === "completed") {
        const nodeConfig = workflowConfig?.nodes.find((n) => n.id === node.id)
        if (nodeConfig?.output_schema) {
          if (node.capturedOutput !== undefined && node.capturedOutput !== null) {
            yield* dag.nodeCompleted(dagID, node.id, node.capturedOutput)
          } else {
            yield* dag.nodeFailed(dagID, node.id, "output_schema declared but submit_result was never successfully called (recovered)", "verdict_fail")
          }
        } else {
          yield* dag.nodeCompleted(dagID, node.id, undefined)
        }
        reconciled++
      } else if (sessionStatus === "failed") {
        yield* dag.nodeFailed(dagID, node.id, "child session failed (recovered)", "exec_failed")
        reconciled++
      } else {
        ownershipLost++
        if (cancelSession) {
          yield* cancelSession(node.childSessionId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DAG recovery failed to cancel child session", {
                dagID,
                nodeID: node.id,
                childSessionID: node.childSessionId,
                cause,
              }),
            ),
          )
        }
        if (node.deadlineMs !== null) {
          const now = yield* Clock.currentTimeMillis
          if (now >= node.deadlineMs) {
            yield* dag.nodeFailed(dagID, node.id, "deadline exceeded on recovery", "timeout")
            reconciled++
            continue
          }
        }
        yield* dag.nodeFailed(
          dagID,
          node.id,
          "execution ownership lost on recovery",
          "exec_failed",
        )
        reconciled++
      }
    }

    return { reconciled, ownershipLost }
  })
}

export function makeSessionStatusChecker(
  sessions: Session.Interface,
): (childSessionID: string) => Effect.Effect<"active" | "completed" | "failed" | "unknown", Error> {
  return (childSessionID) =>
    Effect.gen(function* () {
      const info = yield* sessions.get(SessionID.make(childSessionID)).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!info) return "unknown" as const
      const msgs = yield* sessions.messages({ sessionID: SessionID.make(childSessionID), limit: 1 }).pipe(
        Effect.catch(() => Effect.succeed([] as never)),
      )
      if (msgs.length === 0) return "unknown" as const
      const last = msgs[msgs.length - 1]
      if (last.info.role !== "assistant") return "active" as const
      // An interrupted/aborted session has error set but finish undefined.
      if (last.info.error) return "failed" as const
      const finish = last.info.finish
      if (!finish || finish === "tool-calls" || finish === "unknown") return "active" as const
      if (finish === "error" || finish === "content-filter") return "failed" as const
      // stop, length, and any other terminal finish → completed
      return "completed" as const
    })
}
