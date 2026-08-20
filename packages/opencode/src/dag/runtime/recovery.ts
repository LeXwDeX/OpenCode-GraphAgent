// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

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
import type { NodeConfig } from "../dag"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { isTransitionRejection } from "@opencode-ai/core/dag/core/types"
import { reviewImplementationFingerprint } from "../review-lifecycle"
import { resolveInputMapping } from "./eval"
import { settleCapturedOutput } from "./capture"
import type { CapturedSettlement } from "./capture"
import { captureOutputFileRef, ensureReportAreaGitignore } from "./output-ref"

export function reconcileWorkflow(
  dagID: string,
  checkSessionStatus: (childSessionID: string) => Effect.Effect<"active" | "completed" | "failed" | "unknown", Error>,
  cancelSession?: (sessionID: string) => Effect.Effect<void, Error>,
  workflowConfig?: { nodes: Pick<NodeConfig, "id" | "output_schema" | "review" | "input_mapping">[] } | null,
  lastAssistantText?: (childSessionID: string) => Effect.Effect<string | undefined, Error>,
  directory?: string,
): Effect.Effect<{ reconciled: number; ownershipLost: number }, Error, Dag.Service> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const nodes = yield* dag.store.getNodes(dagID)
    const settle = (nodeID: string, action: Effect.Effect<void, Error>) =>
      action.pipe(
        Effect.catchIf(
          isTransitionRejection,
          (error) =>
            Effect.logDebug("DAG recovery ignored a concurrent transition rejection", {
              dagID,
              nodeID,
              error,
            }),
        ),
      )
    let reconciled = 0
    let ownershipLost = 0

    for (const node of nodes) {
      // Pending/queued nodes have no live execution attempt — a queued node
      // never created its child session (P0-2: sessions materialize inside
      // the permit), so both re-enter scheduling after runtime reconstruction
      // without any ownership judgement. This includes ordinary
      // dependency-blocked work and restart-orphans; a restart-orphan
      // (pending/queued + stale childSessionId from the attempt it replaced)
      // must have its old child session cancelled here, since spawnReady may
      // never revisit it if the workflow is about to become terminal.
      if (node.status === "pending" || node.status === "queued") {
        if (node.childSessionId && cancelSession) {
          // #349/REC-1: same hardening as the running-node branch below — a
          // persistent cancel failure must not abort the whole reconcile
          // (this workflow would then never be adopted by this process).
          yield* cancelSession(node.childSessionId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DAG recovery failed to cancel stale child session", {
                dagID,
                nodeID: node.id,
                childSessionID: node.childSessionId,
                cause,
              }),
            ),
          )
        }
        continue
      }
      if (node.status !== "running") continue
      if (!node.childSessionId) {
        // Crash landed between admission and session creation — no durable
        // outcome exists, so this is an invented failure like ownership loss.
        ownershipLost++
        yield* settle(
          node.id,
          dag.nodeFailed(dagID, node.id, "node was running but had no child session on recovery", "exec_failed"),
        )
        reconciled++
        continue
      }

      // Checker failures propagate: aborting this reconcile (callers log and
      // retry on next access) beats inventing a nodeFailed from a read error.
      const sessionStatus = yield* checkSessionStatus(node.childSessionId)

      if (sessionStatus === "completed") {
        // #345 parity with the live path: an unparseable workflow row must
        // not degrade into the schemaless completion below — a schema-
        // carrying node would bypass settleCapturedOutput and land as an
        // undefined output. Fail loudly instead of inventing a settlement.
        if (workflowConfig === null) {
          ownershipLost++
          yield* settle(
            node.id,
            dag.nodeFailed(
              dagID,
              node.id,
              "child session completed but the workflow config is unparseable on recovery — cannot settle safely",
              "exec_failed",
            ),
          )
          reconciled++
          continue
        }
        const nodeConfig = workflowConfig?.nodes.find((n) => n.id === node.id)
        if (nodeConfig?.output_schema) {
          // Same settlement decision as spawn's completion gate — recovery
          // must not become a bypass of the review-result contract again (B1).
          const settlement = recoveredSettlement(nodeConfig, nodes, node.capturedOutput)
          yield* settle(
            node.id,
            settlement.kind === "complete"
              ? dag.nodeCompleted(dagID, node.id, settlement.output)
              : dag.nodeFailed(dagID, node.id, settlement.reason, "verdict_fail"),
          )
        } else {
          // #345: the live path (spawn.ts) completes a schemaless node with
          // the child's last assistant text; recovery must mirror it instead
          // of completing with undefined — a schemaless checkpoint's string
          // verdict (e.g. a bare {"verdict":"replan"} reply) would silently
          // vanish after a crash otherwise: no pause, no warning, and gated
          // dependents resolve no fields. Callers that inject no reader keep
          // the legacy undefined settlement.
          const rawText = lastAssistantText
            ? (yield* lastAssistantText(node.childSessionId)) ?? ""
            : undefined
          // #388 parity with the live path: when the recovered reply IS one
          // existing absolute file path, capture the same {content_ref, size,
          // sha256, summary} receipt submit-time detection records, so live
          // and recovered settlement produce identical durable output
          // metadata. Best-effort like the live path — any anomaly keeps the
          // plain inline completion and never fails the node.
          if (rawText) {
            const fileRef = yield* captureOutputFileRef(rawText)
            if (fileRef) {
              yield* dag.store.setCapturedOutput(node.childSessionId, fileRef).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("DAG recovery output-ref capture persistence failed — inline output preserved", {
                    dagID,
                    nodeID: node.id,
                    cause,
                  }),
                ),
              )
              if (directory) yield* ensureReportAreaGitignore(directory, fileRef.path)
            }
          }
          yield* settle(node.id, dag.nodeCompleted(dagID, node.id, rawText))
        }
        reconciled++
      } else if (sessionStatus === "failed") {
        yield* settle(
          node.id,
          dag.nodeFailed(dagID, node.id, "child session failed (recovered)", "exec_failed"),
        )
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
            // S2: recovery of an escalated node preserves the timeout semantics
            // — the extension budget was spent before the crash, the deadline
            // was never re-extended, and the durable escalation count proves
            // it. Failure reason records the escalation so the parent can tell
            // "ran out of time after N extensions" from "never escalated".
            yield* settle(
              node.id,
              dag.nodeFailed(
                dagID,
                node.id,
                node.timeoutExtensions > 0
                  ? `timeout escalated (${node.timeoutExtensions} extension(s)) node failed on recovery`
                  : "deadline exceeded on recovery",
                "timeout",
              ),
            )
            reconciled++
            continue
          }
        }
        yield* settle(
          node.id,
          dag.nodeFailed(
            dagID,
            node.id,
            "execution ownership lost on recovery",
            "exec_failed",
          ),
        )
        reconciled++
      }
    }

    return { reconciled, ownershipLost }
  })
}

/**
 * Recovery-side wrapper around the shared settlement decision
 * (capture.ts settleCapturedOutput). Resolves the implementation fingerprint
 * from durable sibling rows — the same source input_mapping reads from — then
 * delegates. An unresolvable fingerprint fails conservatively: re-running the
 * review is always safe; completing an unvalidated one is not.
 *
 * Known asymmetry vs the spawn path: loop.ts passes the fingerprint through
 * sanitizeInput before spawning, this path reads the raw durable value. A
 * fingerprint the sanitizer would rewrite can therefore only produce a
 * spurious mismatch → forced re-run, never a false accept; typical hashes are
 * untouched by the sanitizer.
 */
function recoveredSettlement(
  nodeConfig: Pick<NodeConfig, "review" | "input_mapping">,
  rows: readonly DagStore.NodeRow[],
  captured: unknown,
): CapturedSettlement {
  if (nodeConfig.review?.phase !== "diff") return settleCapturedOutput(captured, undefined, " (recovered)")
  const resolved = resolveInputMapping(nodeConfig.input_mapping, (nodeID) => rows.find((row) => row.id === nodeID)?.output)
  const fingerprint = reviewImplementationFingerprint(nodeConfig, resolved)
  if (!fingerprint) return { kind: "fail", reason: "review implementation fingerprint could not be resolved from durable state (recovered)" }
  return settleCapturedOutput(captured, fingerprint, " (recovered)")
}

export function makeSessionStatusChecker(
  sessions: Session.Interface,
): (childSessionID: string) => Effect.Effect<"active" | "completed" | "failed" | "unknown", Error> {
  return (childSessionID) =>
    Effect.gen(function* () {
      // Only a missing session is legitimate "unknown"; any other failure must
      // propagate so recovery aborts instead of inventing node failures from
      // fabricated evidence. DB-level errors are already defects (orDie).
      const info = yield* sessions.get(SessionID.make(childSessionID)).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
      )
      if (!info) return "unknown" as const
      const msgs = yield* sessions.messages({ sessionID: SessionID.make(childSessionID), limit: 1 }).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed([] as SessionV1.WithParts[])),
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

/**
 * #345: the schemaless-node completion mirror of the live path — the child's
 * last assistant text part, the exact value spawn.ts settles a schemaless
 * node with. Recovery reads it so a crash cannot erase a string verdict.
 */
export function makeLastAssistantTextReader(
  sessions: Session.Interface,
): (childSessionID: string) => Effect.Effect<string | undefined, Error> {
  return (childSessionID) =>
    Effect.gen(function* () {
      const msgs = yield* sessions
        .messages({ sessionID: SessionID.make(childSessionID), limit: 20 })
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed([] as SessionV1.WithParts[])))
      const last = [...msgs].reverse().find((msg) => msg.info.role === "assistant")
      return last?.parts.findLast((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")?.text
    })
}
