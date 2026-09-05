// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DAG node spawn — reuses the `task` tool's spawn path.
 *
 * A ready node spawns a real child Session through the same contract as task.ts:
 * Agent.Service.get → Session.Service.create(parentID) → deriveSubagentSessionPermission → promptOps.prompt.
 *
 * Admission model (P0-2): the node is durably QUEUED at dispatch — the child
 * session and NodeStarted only materialize INSIDE the concurrency permit, so a
 * 100-node fan-out no longer creates 100 sessions and shows 100 "running"
 * rows while true concurrency is 5. The admission deadline is fixed when the
 * node is admitted (deadline = admission time + timeout_ms) and is NOT
 * adjusted by running-node extensions (F4): the replan/extend handler re-times
 * RUNNING nodes only, so a queued node's pre-permit wait keeps its admission
 * deadline — queue wait counts toward the node's budget, and an expired
 * queued node fails directly via the pre-permit timeout path (no progress to
 * protect). A queued node absent from a plain replan fragment is superseded
 * (cancelled) by planReplan; the additive extend path re-admits it with a
 * fresh admission deadline.
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

import { Effect, Semaphore, Scope, Fiber, Option, Clock, Cause, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { SessionPrompt } from "@/session/prompt"
import { Dag, type NodeExecutionAttempt } from "../dag"
import { DagModel } from "../model"
import { DagLocation } from "../location"
import { InstanceRef } from "@/effect/instance-ref"
import { isTransitionRejection, isNodeTerminalStatus } from "@opencode-ai/core/dag/core/types"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { registerCaptureSlot, clearCaptureSlot, settleCapturedOutput, settlePlainTextOutput } from "./capture"
import { captureOutputFileRef, ensureReportAreaGitignore } from "./output-ref"

type PromptParts = SessionPrompt.PromptInput["parts"]

export interface NodeSpawnInput {
  dagID: string
  nodeID: string
  node: DagStore.NodeRow
  /** Config generation paired with the node snapshot during scheduler admission. */
  graphRev?: number
  /** Runs after durable admission succeeds and before any watcher or execution fiber starts. */
  onAdmitted?: Effect.Effect<void, never>
  parentSessionID: string
  promptParts: PromptParts
  /** Workflow execution directory — keys the report-area gitignore guarantee (Train B, B4). */
  directory?: string
  outputSchema?: Record<string, unknown>
  timeoutMs?: number
  reportToParent?: boolean
  reviewImplementationFingerprint?: string
  /** dag.jsonc tier default — authoritative unless a persisted legacy node model exists. */
  fallbackModel?: { modelID: string; providerID: string }
  /** dag.jsonc thinking_depth — forwarded as the prompt variant (no-op unless the model defines it). */
  variant?: string
  /** Workflow-level timeout extension cap (defaults to DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions). */
  maxTimeoutExtensions?: number
}

export interface NodeSpawnResult {
  fiber: Fiber.Fiber<unknown, unknown>
  /** Deadline watcher fiber — rebuilt by the replan handler when the deadline is extended. */
  watcherFiber: Fiber.Fiber<unknown, unknown>
}

export interface DeadlineWatcherInput {
  dagID: string
  nodeID: string
  /** Durable attempt captured when this watcher was created. */
  attempt?: NodeExecutionAttempt
  /**
   * The node's effective execution timeout. Doubles as the escalation
   * interval (S1): after escalating, the watcher waits one timeout period
   * before re-reading — an extended deadline (replan adjudication) moves the
   * row's deadline into the future and the loop sleeps until it; an untouched
   * deadline escalates again, driving the count toward the extension cap.
   */
  timeoutMs?: number
  /** Workflow-level timeout extension cap (defaults to DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions). */
  maxTimeoutExtensions?: number
}

/**
 * Deadline watcher (timeout = signal, not failure). Sleeps until the node's
 * absolute deadline, then reads the durable row:
 * - node no longer running → exit (cancelled/restarted/completed)
 * - deadline extended on the row (replan with a new timeout_ms) → re-sleep
 * - extension cap exhausted → cancel the child + nodeFailed("timeout")
 * - otherwise → publish NodeTimeoutEscalated (node stays RUNNING)
 * The row is the single source of truth, so a watcher that survives its
 * execution fiber (interrupt misses) self-heals on the next wake-up.
 *
 * S1: the watcher self-renews — it does NOT exit after escalating. It waits
 * one escalate interval and re-reads the row: a replan that extended the
 * deadline (a NEW worker_config.timeout_ms — nodeExtendTimeout recomputes
 * from now per §3.7) is picked up on the next read; a deadline the main agent
 * never adjudicated escalates AGAIN, so the extension count climbs toward the
 * cap and supervision stays bounded even when no replan ever arrives. F5: a
 * queued/pending/paused node past its deadline still polls instead of
 * exiting — the node may yet acquire the permit inside its admission window
 * (edge-deadline permit) and start running under supervision.
 */
export function makeDeadlineWatcher(
  input: DeadlineWatcherInput,
): Effect.Effect<void, never, Dag.Service | SessionPrompt.Service> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const promptSvc = yield* SessionPrompt.Service
    const escalateIntervalMs = Math.max(1_000, input.timeoutMs ?? Dag.DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs)
    // Read the durable row. Transient store failures (SQLite lock blips,
    // connection hiccups) must NOT end supervision — a single failed read
    // would otherwise permanently orphan the node's timeout path — so the
    // read retries with a short backoff (R13) and only gives up after every
    // attempt fails. Effect.exit captures both effect failures and defects.
    const readNode = Effect.gen(function* () {
      for (let attemptNo = 0; attemptNo <= 3; attemptNo++) {
        const outcome = yield* dag.store.getNode(input.dagID, input.nodeID).pipe(Effect.exit)
        if (Exit.isSuccess(outcome)) return outcome.value
        if (attemptNo < 3) yield* Effect.sleep(500)
      }
      yield* Effect.logWarning("DAG deadline watcher giving up after store read retries", { dagID: input.dagID, nodeID: input.nodeID })
      return undefined
    })
    // DAG-LOC-01 (P2-C + review P2): revalidate ownership before the write
    // section — escalation and cap-enforcement writes must not land on a
    // workflow whose durable identity was repainted (identity migration) or
    // whose rows were cascade-deleted. Losing ownership ends this watcher's
    // mandate; the instance that owns the repainted workflow supervises it.
    // The check only runs when it can DISPROVE ownership (instance context
    // and Database both present — always true for watchers forked from
    // DagLoop): absent either, supervision must not end (R13).
    //
    // Review P2: this read follows the same exit+retry pattern as readNode
    // above — a transient store defect must be treated as "cannot disprove
    // ownership" (continue supervising), never as a reason to end the
    // mandate. Unretried, it is the watcher's only store read without R13
    // protection: a defect dies through the outer catchCause, which logs and
    // completes the fiber — permanently ending deadline supervision for a
    // still-running node (no escalation, no cap, unbounded run; nothing
    // re-forks the watcher).
    const ownershipLost = Effect.gen(function* () {
      const instance = yield* InstanceRef
      const db = yield* Effect.serviceOption(Database.Service)
      if (!instance || db._tag === "None") return false
      for (let attemptNo = 0; attemptNo <= 3; attemptNo++) {
        const outcome = yield* DagLocation.ownsWorkflow(input.dagID, instance.directory).pipe(Effect.exit)
        if (Exit.isSuccess(outcome)) return !outcome.value
        if (attemptNo < 3) yield* Effect.sleep(500)
      }
      yield* Effect.logWarning(
        "DAG deadline watcher ownership revalidation failed after store retries — keeping supervision",
        { dagID: input.dagID, nodeID: input.nodeID },
      )
      return false
    })
    for (;;) {
      const node = yield* readNode
      if (!node) {
        // Store read failed after all retries — do NOT exit (the watcher
        // "must not end supervision"). Sleep with a longer backoff and
        // retry the read in the next loop iteration; a transient store
        // outage should not permanently orphan the node's timeout path.
        yield* Effect.sleep(5_000)
        continue
      }
      if (
        input.attempt &&
        (node.replanAttempts !== input.attempt.replanAttempts ||
          (input.attempt.childSessionID !== undefined && node.childSessionId !== input.attempt.childSessionID))
      ) return
      if (isNodeTerminalStatus(node.status as never)) return
      if (yield* ownershipLost) return
      const now = yield* Clock.currentTimeMillis
      const deadline = node.deadlineMs
      if (node.status !== "running") {
        // Pre-running wait (F5): a queued/pending/paused node past its
        // deadline may still acquire the permit inside its admission window —
        // do not abandon supervision; poll until it starts, terminalizes, or
        // the pre-permit timeout path fails it.
        yield* Effect.sleep(sleepUntilDeadlineMs(deadline, now, 1_000))
        continue
      }
      if (deadline === null || deadline > now) {
        yield* Effect.sleep(sleepUntilDeadlineMs(deadline, now, 10))
        continue
      }
      const extensions = node.timeoutExtensions
      const maxExtensions = input.maxTimeoutExtensions ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions
      if (extensions >= maxExtensions) {
        // Enforcing the cap IS the watcher's contract (§5-5), so a transient
        // failure here must retry rather than end supervision: returning would
        // leave a RUNNING node past its cap with nobody left to fail it. A
        // rejected guard means someone else already terminalized the node,
        // which counts as done.
        const attempt = {
          replanAttempts: node.replanAttempts,
          ...(node.childSessionId ? { childSessionID: node.childSessionId } : {}),
        }
        const outcome = yield* dag.nodeFailed(input.dagID, input.nodeID, `timeout extensions exhausted (${extensions}/${maxExtensions})`, "timeout", attempt).pipe(
          Effect.as("failed" as const),
          Effect.catchIf(
            isTransitionRejection,
            () =>
              Effect.logWarning("nodeFailed (timeout extensions exhausted) guard rejected — node attempt is no longer current").pipe(
                Effect.as("stale" as const),
              ),
          ),
          Effect.exit,
        )
        if (Exit.isSuccess(outcome)) {
          if (outcome.value === "stale") return
          if (node.childSessionId) yield* promptSvc.cancel(node.childSessionId as never).pipe(Effect.ignore)
          return
        }
        if (Cause.hasInterrupts(outcome.cause)) return yield* Effect.failCause(outcome.cause)
        yield* Effect.logWarning("DAG deadline watcher cap enforcement failed — retrying", { dagID: input.dagID, nodeID: input.nodeID, cause: outcome.cause })
        yield* Effect.sleep(escalateIntervalMs)
        continue
      }
      // The escalate write takes the workflow lock and publishes a durable
      // event, so it can fail with a typed Error (lock contention) or die (a
      // publish defect). Neither may end supervision: an exited watcher stops
      // escalating, the extension count stops climbing, `extensions >=
      // maxExtensions` never becomes true, and the node occupies a concurrency
      // slot unbounded. Log and fall through to the sleep — the next iteration
      // re-reads the row and escalates again. Mirrors the read path's R13
      // hardening above, which the write path previously lacked.
      // The deadline this watcher OBSERVED may be stale — it was read WITHOUT
      // the workflow lock (readNode above). nodeTimeoutEscalated re-reads the
      // node under the lock and suppresses the escalation when the deadline has
      // moved past this observed value (ticket B — spurious T8 suppression),
      // so a budget unit is only charged when the node is genuinely still
      // overdue. Pass node.deadlineMs, the value this snapshot read.
      const attempt = {
        replanAttempts: node.replanAttempts,
        ...(node.childSessionId ? { childSessionID: node.childSessionId } : {}),
      }
      const escalated = yield* dag.nodeTimeoutEscalated(input.dagID, input.nodeID, node.childSessionId as never, extensions + 1, node.deadlineMs, attempt).pipe(
        Effect.catchIf(
          isTransitionRejection,
          () => Effect.logWarning("nodeTimeoutEscalated guard rejected — node already terminal"),
        ),
        Effect.exit,
      )
      if (Exit.isFailure(escalated)) {
        if (Cause.hasInterrupts(escalated.cause)) return yield* Effect.failCause(escalated.cause)
        yield* Effect.logWarning("DAG deadline watcher escalation failed — keeping supervision and retrying", { dagID: input.dagID, nodeID: input.nodeID, cause: escalated.cause })
      }
      // Self-renew (S1): stay alive after escalating. Wait one escalate
      // interval, then loop — the re-read sees an extended deadline (replan
      // adjudication via nodeExtendTimeout) and sleeps until it, or sees a
      // still-past deadline and escalates AGAIN. Repeated escalation is what
      // drives the count toward the cap, so a main agent that never replans
      // cannot leave the node running unbounded.
      yield* Effect.sleep(escalateIntervalMs)
    }
  }).pipe(
    // Last-resort net for defects outside the loop's own handling. Use
    // hasInterrupts, not interruptors: the latter collects DEFINED fiber IDs
    // and silently ignores interrupt reasons carrying none, which would
    // misclassify such an interrupt as an error.
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.void
        : Effect.logWarning("DAG deadline watcher exited with an error", { cause }),
    ),
  )
}

/**
 * How long the deadline watcher sleeps before re-reading the node row. With no
 * deadline yet, poll fast (100ms) so a late deadline write is seen quickly;
 * with a future deadline, sleep exactly until it (min 10ms); once past the
 * deadline, back off by overdueMs before the next read.
 */
function sleepUntilDeadlineMs(deadlineMs: number | null, now: number, overdueMs: number) {
  if (deadlineMs === null) return 100
  if (deadlineMs > now) return Math.max(deadlineMs - now, 10)
  return overdueMs
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
    const admissionAttempt = {
      replanAttempts: input.node.replanAttempts,
      nodeSeq: input.node.seq,
      ...(input.graphRev !== undefined ? { graphRev: input.graphRev } : {}),
    } satisfies NodeExecutionAttempt
    const executionAttempt = {
      replanAttempts: input.node.replanAttempts,
    } satisfies NodeExecutionAttempt

    // Pre-admission failures settle here and return an empty fiber (same
    // shape as the !admitted path below) instead of Effect.fail — failing
    // would make the caller's catchCause publish a second, guard-rejected
    // NodeFailed (noise).
    const failWithoutFiber = (reason: string, label: string) =>
      Effect.gen(function* () {
        yield* dag.nodeFailed(input.dagID, input.nodeID, reason, "exec_failed", admissionAttempt).pipe(
          Effect.catchIf(
            isTransitionRejection,
            () => Effect.logWarning(`nodeFailed (${label}) guard rejected — node already terminal`),
          ),
        )
        return { fiber: yield* Effect.forkIn(scope)(Effect.void), watcherFiber: yield* Effect.forkIn(scope)(Effect.void) }
      })

    const agent = yield* agentService.get(input.node.workerType).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (!agent) {
      return yield* failWithoutFiber(`unknown worker_type: ${input.node.workerType}`, "unknown worker_type")
    }

    const parentOutcome = yield* sessions.get(SessionID.make(input.parentSessionID)).pipe(Effect.exit)
    if (Exit.isFailure(parentOutcome)) {
      if (Cause.hasInterrupts(parentOutcome.cause)) return yield* Effect.failCause(parentOutcome.cause)
      return yield* failWithoutFiber(Cause.pretty(parentOutcome.cause), "parent session lookup")
    }
    const parent = parentOutcome.value
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
      return yield* failWithoutFiber(`no model configured for agent: ${agent.name}`, "no model")
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
    const admitted = yield* dag.nodeQueued(input.dagID, input.nodeID, deadlineMs, admissionAttempt).pipe(
      Effect.as(true),
      Effect.catchIf(
        isTransitionRejection,
        () =>
          Effect.logWarning(`Node ${input.nodeID} admission was rejected — no execution attempt started`).pipe(
            Effect.as(false),
          ),
      ),
    )
    if (!admitted) {
      const fiber = yield* Effect.forkIn(scope)(Effect.void)
      const watcherFiber = yield* Effect.forkIn(scope)(Effect.void)
      return { fiber, watcherFiber }
    }
    if (input.onAdmitted) yield* input.onAdmitted

    // Assigned inside the fiber once the child session materializes; read by
    // the ensuring/onInterrupt cleanups below.
    let childSessionID: string | undefined

    // Forked first so the execution fiber's cleanup closures can capture it.
    const watcherFiber = yield* Effect.forkIn(scope)(
      makeDeadlineWatcher({
        dagID: input.dagID,
        nodeID: input.nodeID,
        attempt: executionAttempt,
        timeoutMs,
        maxTimeoutExtensions: input.maxTimeoutExtensions,
      }),
    )

    const fiber = yield* Effect.forkIn(scope)(
      Effect.gen(function* () {
        // P1(#1): Acquire permit with a deadline-bounded timeout so the node
        // doesn't wait unbounded in the semaphore queue. If the deadline
        // elapses while waiting, fail immediately.
        const queueTime = yield* Clock.currentTimeMillis
        const queueRemaining = deadlineMs - queueTime
        if (queueRemaining <= 0) {
          yield* dag.nodeFailed(input.dagID, input.nodeID, `node exceeded timeout before acquiring execution permit`, "timeout", executionAttempt).pipe(
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
          yield* dag.nodeFailed(input.dagID, input.nodeID, `node exceeded timeout while waiting for execution permit`, "timeout", executionAttempt).pipe(
            Effect.catchIf(
              isTransitionRejection,
              () => Effect.logWarning("nodeFailed (permit-wait timeout) guard rejected — node already terminal"),
            ),
          )
          return
        }
        try {
          // #379 pause fence: scheduler admission is the only pause gate, so a
          // node queued before control(pause) still holds a spawn fiber that
          // would materialize its child session the moment a permit frees —
          // contradicting the documented pause contract ("prevents new nodes
          // from spawning"). Hold the fiber here while the durable workflow
          // row reads `paused`: the node stays queued (never terminalized) and
          // the fiber proceeds on control(resume). A workflow that was deleted
          // or terminalized during the wait falls through to the adoption
          // fence / nodeStarted guard below, which already no-op dead targets.
          // The status read fails open (unreadable ⇒ treat as not paused):
          // the adoption fence below is the authoritative revalidation, so a
          // transient store blip must not kill the spawn fiber here.
          // Effect.suspend defers the call so even a store facade lacking the
          // method surfaces as a captured defect instead of a synchronous throw.
          const readPauseStatus = Effect.exit(Effect.suspend(() => dag.store.getWorkflow(input.dagID))).pipe(
            Effect.map((outcome) => (Exit.isSuccess(outcome) ? outcome.value?.status : undefined)),
          )
          if ((yield* readPauseStatus) === "paused") {
            yield* Effect.logWarning(
              `Workflow ${input.dagID} paused while node ${input.nodeID} was queued — holding spawn until resume`,
            )
            while ((yield* readPauseStatus) === "paused") {
              yield* Effect.sleep(250)
            }
          }
          // #270 window-2 spawn-admission fence (C4): the node was durably
          // admitted (nodeQueued above) but the child session is about to
          // materialize — a deletion cascade (Session.remove → FK) committed in
          // that window must fence the spawn instead of letting it create an
          // orphan child for a dead workflow. Re-admit ATOMICALLY right before
          // sessions.create: the claim matches only while the workflow row exists
          // and is non-terminal, so a committed deletion matches zero rows and the
          // spawn aborts before any child session exists (no post-deletion spawn
          // survives). This is the revalidation that closes the spawn window the
          // nodeQueued guard alone leaves open between its read and its publish.
          if (!(yield* dag.store.tryClaimAdoption(input.dagID))) return
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
          const terminalized = yield* dag.nodeStarted(input.dagID, input.nodeID, childSession.id, deadlineMs, input.reportToParent, executionAttempt).pipe(
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
            Effect.onError(() => promptSvc.cancel(childSession.id).pipe(Effect.ignore)),
          )
          if (terminalized) return

          const settlementAttempt = {
            replanAttempts: input.node.replanAttempts,
            childSessionID: childSession.id,
          } satisfies NodeExecutionAttempt

          if (input.outputSchema) registerCaptureSlot(childSession.id, input.outputSchema)

          // The prompt runs WITHOUT a timeout — the deadline watcher owns the
          // timeout path (escalate signal vs exhausted-force-cancel). A timeout
          // never interrupts the child session mid-work; it only notifies the
          // main agent, which adjudicates (extend / cancel / replan).
          const result = yield* promptSvc.prompt({
            messageID: MessageID.ascending(),
            sessionID: childSession.id,
            model,
            agent: agent.name,
            ...(input.variant ? { variant: input.variant } : {}),
            parts: input.promptParts,
          })
          if (input.outputSchema) {
            const readSettlement = Effect.fn("DagRuntime.spawn.readSettlement")(function* () {
              const updatedNode = yield* dag.store.getNode(input.dagID, input.nodeID).pipe(Effect.orDie)
              if (
                !updatedNode ||
                updatedNode.replanAttempts !== settlementAttempt.replanAttempts ||
                updatedNode.childSessionId !== settlementAttempt.childSessionID
              ) return undefined
              const captured = updatedNode?.capturedOutput
              return {
                neverCalled: captured === undefined || captured === null,
                // Single settlement authority shared with crash recovery
                // (capture.ts settleCapturedOutput).
                settlement: settleCapturedOutput(captured, input.reviewImplementationFingerprint),
              }
            })
            clearCaptureSlot(childSession.id)
            let verdict = yield* readSettlement()
            if (!verdict) return
            // Issue #436 minimal step: a child that ended its whole turn
            // without ever calling submit_result gets exactly one nudge
            // turn in the same session — the work is already done, only the
            // structured hand-back is missing. A captured-but-invalid payload
            // is NOT nudged: that is a deterministic contract violation and
            // a retry would only re-bill the same mistake.
            if (verdict.settlement.kind === "fail" && verdict.neverCalled) {
              registerCaptureSlot(childSession.id, input.outputSchema)
              yield* promptSvc.prompt({
                messageID: MessageID.ascending(),
                sessionID: childSession.id,
                model,
                agent: agent.name,
                ...(input.variant ? { variant: input.variant } : {}),
                parts: [
                  {
                    type: "text",
                    text: `You ended your turn without calling the submit_result tool, so this node recorded no output and will FAIL. Do not redo the work. Call submit_result NOW with a JSON payload matching the schema from your instructions, containing your full result. If a previous submit_result call failed validation, fix the payload shape and call it again.`,
                  },
                ],
              })
              clearCaptureSlot(childSession.id)
              verdict = yield* readSettlement()
              if (!verdict) return
            }
            const settlement = verdict.settlement
            yield* (settlement.kind === "complete"
              ? dag.nodeCompleted(input.dagID, input.nodeID, settlement.output, settlementAttempt)
              : dag.nodeFailed(input.dagID, input.nodeID, settlement.reason, "verdict_fail", settlementAttempt)
            ).pipe(
              Effect.catchIf(
                isTransitionRejection,
                () => Effect.logWarning(`${settlement.kind === "complete" ? "nodeCompleted" : "nodeFailed (verdict_fail)"} guard rejected — node already terminal`),
              ),
            )
          } else {
            const settlement = settlePlainTextOutput(result.parts.findLast((p) => p.type === "text")?.text)
            if (settlement.kind === "fail") {
              yield* dag.nodeFailed(
                input.dagID,
                input.nodeID,
                settlement.reason,
                "verdict_fail",
                settlementAttempt,
              ).pipe(
                Effect.catchIf(
                  isTransitionRejection,
                  () => Effect.logWarning("nodeFailed (empty output) guard rejected — node already terminal"),
                ),
              )
              return
            }
            const rawText = settlement.output
            // Train B (v1.0.15 B2): submit-time file-ref detection — when the
            // reply IS an existing non-empty absolute path, record
            // {content_ref, size, sha256, summary} in captured_output (the
            // same durable column submit_result uses; reset on NodeStarted).
            // The settlement stays the raw string: input mapping, wake
            // digests, and legacy readers keep the exact inline behavior,
            // and the result seam serves the pointer (B3). Any anomaly keeps
            // the inline path — the capture must never fail the node.
            const fileRef = yield* captureOutputFileRef(rawText)
            if (fileRef && childSessionID) {
              yield* dag.store.setCapturedOutput(childSessionID, fileRef).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("output-ref capture persistence failed — inline output preserved", { cause }),
                ),
              )
              if (input.directory) yield* ensureReportAreaGitignore(input.directory, fileRef.path)
            }
            yield* dag.nodeCompleted(input.dagID, input.nodeID, rawText, settlementAttempt).pipe(
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
          Effect.gen(function* () {
            // The prompt finished (or this fiber was interrupted) — the
            // deadline watcher has no further job.
            yield* Fiber.interrupt(watcherFiber).pipe(Effect.ignore)
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
            if (Cause.hasInterrupts(cause)) return
            const attempt = childSessionID
              ? { replanAttempts: input.node.replanAttempts, childSessionID }
              : executionAttempt
            yield* dag.nodeFailed(input.dagID, input.nodeID, Cause.pretty(cause), "exec_failed", attempt).pipe(
              Effect.catchIf(
                isTransitionRejection,
                () => Effect.logWarning("nodeFailed guard rejected — node already terminal"),
              ),
            )
          }),
        ),
      ),
    )

    return { fiber, watcherFiber }
  })
}
