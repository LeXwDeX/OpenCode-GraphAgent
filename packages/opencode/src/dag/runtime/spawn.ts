/**
 * DAG node spawn — reuses the `task` tool's spawn path.
 *
 * A ready node spawns a real child Session through the same contract as task.ts:
 * Agent.Service.get → Session.Service.create(parentID) → deriveSubagentSessionPermission → promptOps.prompt.
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
import { validateReviewResult } from "../review-lifecycle"
import { InvalidTransitionError, TerminalViolationError } from "@opencode-ai/core/dag/core/types"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { registerCaptureSlot, clearCaptureSlot } from "./capture"

type PromptParts = SessionPrompt.PromptInput["parts"]

const isTransitionRejection = (err: unknown): err is InvalidTransitionError | TerminalViolationError =>
  err instanceof InvalidTransitionError || err instanceof TerminalViolationError

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
}

export interface NodeSpawnResult {
  childSessionID: string
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
          modelID: persistedNodeModel.modelID as never,
          providerID: persistedNodeModel.providerID as never,
        }
      : undefined
    const model = nodeModel
      ?? (agent.model ? { modelID: agent.model.modelID, providerID: agent.model.providerID } : undefined)
      ?? (parent.model ? { modelID: parent.model.id, providerID: parent.model.providerID } : undefined)
    if (!model) {
      yield* dag.nodeFailed(input.dagID, input.nodeID, `no model configured for agent: ${agent.name}`, "exec_failed")
      return yield* Effect.fail(new Error(`No model configured for agent: ${agent.name}`))
    }

    const childPermission = deriveSubagentSessionPermission({
      parentSessionPermission: parent.permission ?? [],
      subagent: agent,
    })

    const childSession = yield* sessions.create({
      parentID: SessionID.make(input.parentSessionID),
      title: `${input.node.name} (DAG node)`,
      agent: agent.name,
      model: { id: model.modelID, providerID: model.providerID },
      permission: childPermission,
    })

    // Resolve timeout and compute absolute deadline (D0 path 1).
    // The deadline is computed at spawn time and persisted so crash-recovery
    // can inherit it. The actual timeout race uses the REMAINING time from
    // when the semaphore permit is acquired — queue wait counts toward the
    // deadline, preventing a node that queued past its deadline from running.
    const timeoutMs = input.timeoutMs ?? Dag.DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs
    const spawnTime = yield* Clock.currentTimeMillis
    const deadlineMs = spawnTime + timeoutMs

    // If a concurrent replan(cancel/restart) terminalized the node during the
    // async window (agent resolution / session creation above), nodeStarted's
    // guard rejects with TerminalViolationError. Cancel the orphaned child
    // session and return a no-op fiber — the winning cancel/restart is the
    // sole terminalization, no spurious NodeFailed should be published.
    const terminalized = yield* dag.nodeStarted(input.dagID, input.nodeID, childSession.id, deadlineMs, input.reportToParent).pipe(
      Effect.map(() => false),
      Effect.catchIf(
        isTransitionRejection,
        () =>
          Effect.gen(function* () {
            yield* promptSvc.cancel(childSession.id).pipe(Effect.catch(() => Effect.void))
            yield* Effect.logWarning(`Node ${input.nodeID} was terminalized during spawn — child session cancelled, no spurious failure published`)
            return true
          }),
      ),
    )

    if (terminalized) {
      const fiber = yield* Effect.forkIn(scope)(Effect.void)
      return { childSessionID: childSession.id as string, fiber }
    }

    if (input.outputSchema) registerCaptureSlot(childSession.id, input.outputSchema)

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
        // Permit acquired — run the actual prompt with remaining time budget
        const permitTime = yield* Clock.currentTimeMillis
        const remainingMs = Math.max(0, deadlineMs - permitTime)
        try {
          const resultOpt = yield* promptSvc.prompt({
            messageID: MessageID.ascending(),
            sessionID: childSession.id,
            model,
            agent: agent.name,
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
            if (input.outputSchema) clearCaptureSlot(childSession.id)
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.interruptors(cause).size > 0) return
            yield* dag.nodeFailed(input.dagID, input.nodeID, String(cause), "exec_failed").pipe(
              Effect.catchIf(
                isTransitionRejection,
                () => Effect.logWarning("nodeFailed guard rejected — node already terminal"),
              ),
            )
          }),
        ),
      ),
    )

    return { childSessionID: childSession.id as string, fiber }
  })
}
