/**
 * DAG node spawn — reuses the `task` tool's spawn path.
 *
 * A ready node spawns a real child Session through the same contract as task.ts:
 * Agent.Service.get → Session.Service.create(parentID) → deriveSubagentSessionPermission → promptOps.prompt.
 *
 * Admission model (P0-2): the node is durably QUEUED at dispatch — the child
 * session and NodeStarted only materialize INSIDE the concurrency permit, so a
 * 100-node fan-out no longer creates 100 sessions and shows 100 "running"
 * rows while true concurrency is 5. The deadline is fixed at admission time:
 * queue wait counts toward the node's budget.
 *
 * Completion model (mirrors task.ts:210-221): a node completes when its child
 * session's prompt() resolves; it fails when prompt() fails. The completion
 * signal (NodeCompleted / NodeFailed) is published from inside the forked
 * execution fiber, preserving concurrency.
 *
 * Output (Level 1): the final text part of the prompt result, same extraction
 * as task.ts. Structured field-level output for input_mapping/condition
 * (Level 2) is a documented boundary — see eval.ts.
 */

import { Effect, Semaphore, Scope, Fiber, Option, Clock, Cause } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { SessionPrompt } from "@/session/prompt"
import { Dag } from "../dag"
import { DagModel } from "../model"
import { validateReviewResult } from "../review-lifecycle"
import { isTransitionRejection } from "@opencode-ai/core/dag/core/types"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { registerCaptureSlot, clearCaptureSlot } from "./capture"

type PromptParts = SessionPrompt.PromptInput["parts"]

export interface NodeSpawnInput {
  dagID: string
  nodeID: string
  node: DagStore.NodeRow
  parentSessionID: string
  promptParts: PromptParts
  outputSchema?: Record<string, unknown>
  timeoutMs?: number
  reportToParent?: boolean
  reviewImplementationFingerprint?: string
  /** dag.jsonc tier default — authoritative unless a persisted legacy node model exists. */
  fallbackModel?: { modelID: string; providerID: string }
  /** dag.jsonc thinking_depth — forwarded as the prompt variant (no-op unless the model defines it). */
  variant?: string
}

export interface NodeSpawnResult {
  fiber: Fiber.Fiber<unknown, unknown>
}

export function spawnNode(
  semaphore: Semaphore.Semaphore,
  input: NodeSpawnInput,
): Effect.Effect<NodeSpawnResult, Error, Dag.Service | Agent.Service | Session.Service | SessionPrompt.Service | Scope.Scope> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const agentService = yield* Agent.Service
    const sessions = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope

    const agent = yield* agentService.get(input.node.workerType).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (!agent) {
      yield* dag.nodeFailed(input.dagID, input.nodeID, `unknown worker_type: ${input.node.workerType}`, "exec_failed")
      return yield* Effect.fail(new Error(`Unknown worker_type: ${input.node.workerType}`))
    }

    const parent = yield* sessions.get(SessionID.make(input.parentSessionID))
    const persistedNodeModel =
      input.node.modelId && input.node.modelProviderId
        ? Dag.normalizeModel({
            modelID: input.node.modelId,
            providerID: input.node.modelProviderId,
          })
        : undefined
    const nodeModel = persistedNodeModel
      ? {
          modelID: persistedNodeModel.modelID,
          providerID: persistedNodeModel.providerID,
        }
      : undefined
    const resolvedModel = DagModel.resolve({
      node: nodeModel,
      tier: input.fallbackModel,
      agent: agent.model,
      parent: parent.model ? { modelID: parent.model.id, providerID: parent.model.providerID } : undefined,
    })
    if (!resolvedModel) {
      yield* dag.nodeFailed(input.dagID, input.nodeID, `no model configured for agent: ${agent.name}`, "exec_failed")
      return yield* Effect.fail(new Error(`No model configured for agent: ${agent.name}`))
    }
    const model = {
      modelID: ModelV2.ID.make(resolvedModel.modelID),
      providerID: ProviderV2.ID.make(resolvedModel.providerID),
    }

    const childPermission = deriveSubagentSessionPermission({
      parentSessionPermission: parent.permission ?? [],
      subagent: agent,
    })

    // Resolve timeout and compute the absolute deadline at ADMISSION time
    // (P0-2). The deadline is persisted on the durable queued row so
    // crash-recovery can inherit it; queue wait counts toward the budget.
    const timeoutMs = input.timeoutMs ?? Dag.DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs
    const spawnTime = yield* Clock.currentTimeMillis
    const deadlineMs = spawnTime + timeoutMs

    // If a concurrent replan(cancel/restart) terminalized the node during the
    // async window above (agent/model resolution), the queued guard rejects.
    // The winning control op is the sole terminalization — no spurious
    // NodeFailed, no execution fiber.
    const admitted = yield* dag.nodeQueued(input.dagID, input.nodeID, deadlineMs).pipe(
      Effect.as(true),
      Effect.catchIf(
        isTransitionRejection,
        () =>
          Effect.logWarning(`Node ${input.nodeID} was terminalized before queueing — no execution attempt started`).pipe(
            Effect.as(false),
          ),
      ),
    )
    if (!admitted) {
      const fiber = yield* Effect.forkIn(scope)(Effect.void)
      return { fiber }
    }

    // Assigned inside the fiber once the child session materializes; read by
    // the ensuring/onInterrupt cleanups below.
    let childSessionID: string | undefined

    const fiber = yield* Effect.forkIn(scope)(
      Effect.gen(function* () {
        // P1(#1): Acquire permit with a deadline-bounded timeout so the node
        // doesn't wait unbounded in the semaphore queue. If the deadline
        // elapses while waiting, fail immediately.
        const queueTime = yield* Clock.currentTimeMillis
        const queueRemaining = deadlineMs - queueTime
        if (queueRemaining <= 0) {
          yield* dag.nodeFailed(input.dagID, input.nodeID, `node exceeded timeout before acquiring execution permit`, "timeout").pipe(
            Effect.catchIf(
              isTransitionRejection,
              () => Effect.logWarning("nodeFailed (pre-permit timeout) guard rejected — node already terminal"),
            ),
          )
          return
        }
        // Race permit acquisition against the remaining queue budget
        const permitAcquired = yield* Effect.gen(function* () { yield* semaphore.take(1) }).pipe(
          Effect.timeoutOption(queueRemaining),
        )
        if (Option.isNone(permitAcquired)) {
          yield* dag.nodeFailed(input.dagID, input.nodeID, `node exceeded timeout while waiting for execution permit`, "timeout").pipe(
            Effect.catchIf(
              isTransitionRejection,
              () => Effect.logWarning("nodeFailed (permit-wait timeout) guard rejected — node already terminal"),
            ),
          )
          return
        }
        try {
          // Permit acquired — only NOW materialize the child session and mark
          // the node running (P0-2). Before this point the node is durably
          // "queued" with no session: a 100-node fan-out holds at most
          // max_concurrency live sessions.
          const childSession = yield* sessions.create({
            parentID: SessionID.make(input.parentSessionID),
            title: `${input.node.name} (DAG node)`,
            agent: agent.name,
            model: { id: model.modelID, providerID: model.providerID },
            permission: childPermission,
          })
          childSessionID = childSession.id as string

          // A concurrent replan(cancel/restart) may have terminalized the node
          // while it waited for the permit. nodeStarted's guard rejects; cancel
          // the just-created child session and stop — the winning control op is
          // the sole terminalization, no spurious NodeFailed.
          const terminalized = yield* dag.nodeStarted(input.dagID, input.nodeID, childSession.id, deadlineMs, input.reportToParent).pipe(
            Effect.map(() => false),
            Effect.catchIf(
              isTransitionRejection,
              () =>
                Effect.gen(function* () {
                  yield* promptSvc.cancel(childSession.id).pipe(Effect.catch(() => Effect.void))
                  yield* Effect.logWarning(`Node ${input.nodeID} was terminalized during queue wait — child session cancelled, no spurious failure published`)
                  return true
                }),
            ),
          )
          if (terminalized) return

          if (input.outputSchema) registerCaptureSlot(childSession.id, input.outputSchema)

          // Run the actual prompt with the remaining time budget.
          const permitTime = yield* Clock.currentTimeMillis
          const remainingMs = Math.max(0, deadlineMs - permitTime)
          const resultOpt = yield* promptSvc.prompt({
            messageID: MessageID.ascending(),
            sessionID: childSession.id,
            model,
            agent: agent.name,
            ...(input.variant ? { variant: input.variant } : {}),
            parts: input.promptParts,
          }).pipe(Effect.timeoutOption(remainingMs))
          if (Option.isNone(resultOpt)) {
            yield* promptSvc.cancel(childSession.id).pipe(Effect.ignore)
            yield* dag.nodeFailed(input.dagID, input.nodeID, `node exceeded timeout of ${timeoutMs}ms`, "timeout").pipe(
              Effect.catchIf(
                isTransitionRejection,
                () => Effect.logWarning("nodeFailed (timeout) guard rejected — node already terminal"),
              ),
            )
            return
          }
          if (input.outputSchema) {
            clearCaptureSlot(childSession.id)
            const updatedNode = yield* dag.store.getNode(input.dagID, input.nodeID).pipe(Effect.orDie)
            const captured = updatedNode?.capturedOutput
            if (captured !== undefined && captured !== null) {
              if (input.reviewImplementationFingerprint) {
                const reviewResult = validateReviewResult(
                  captured,
                  input.reviewImplementationFingerprint,
                )
                if (!reviewResult.valid) {
                  yield* dag.nodeFailed(
                    input.dagID,
                    input.nodeID,
                    `Review result contract failed: ${reviewResult.errors.join("; ")}`,
                    "verdict_fail",
                  ).pipe(
                    Effect.catchIf(
                      isTransitionRejection,
                      () => Effect.logWarning("nodeFailed (review result contract) guard rejected — node already terminal"),
                    ),
                  )
                  return
                }
              }
              yield* dag.nodeCompleted(input.dagID, input.nodeID, captured).pipe(
                Effect.catchIf(
                  isTransitionRejection,
                  () => Effect.logWarning("nodeCompleted guard rejected — node already terminal"),
                ),
              )
            } else {
              yield* dag.nodeFailed(
                input.dagID, input.nodeID,
                "output_schema declared but submit_result was never successfully called",
                "verdict_fail",
              ).pipe(
                Effect.catchIf(
                  isTransitionRejection,
                  () => Effect.logWarning("nodeFailed (verdict_fail) guard rejected — node already terminal"),
                ),
              )
            }
          } else {
            const rawText = resultOpt.value.parts.findLast((p) => p.type === "text")?.text ?? ""
            if (rawText.trim() === "") {
              yield* dag.nodeFailed(
                input.dagID,
                input.nodeID,
                "provider returned empty output",
                "verdict_fail",
              ).pipe(
                Effect.catchIf(
                  isTransitionRejection,
                  () => Effect.logWarning("nodeFailed (empty output) guard rejected — node already terminal"),
                ),
              )
              return
            }
            yield* dag.nodeCompleted(input.dagID, input.nodeID, rawText).pipe(
              Effect.catchIf(
                isTransitionRejection,
                () => Effect.logWarning("nodeCompleted guard rejected — node already terminal"),
              ),
            )
          }
        } finally {
          yield* semaphore.release(1)
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (input.outputSchema && childSessionID) clearCaptureSlot(childSessionID)
          }),
        ),
        // The fiber can be interrupted between session creation and node
        // settlement (replan cancel/restart, workflow-terminal cleanup). In
        // the pre-NodeStarted window the durable row does not reference the
        // session yet, so the caller's abortChild cannot reach it — cancel
        // the child here.
        Effect.onInterrupt(() =>
          childSessionID
            ? promptSvc.cancel(childSessionID as never).pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.interruptors(cause).size > 0) return
            yield* dag.nodeFailed(input.dagID, input.nodeID, Cause.pretty(cause), "exec_failed").pipe(
              Effect.catchIf(
                isTransitionRejection,
                () => Effect.logWarning("nodeFailed guard rejected — node already terminal"),
              ),
            )
          }),
        ),
      ),
    )

    return { fiber }
  })
}
