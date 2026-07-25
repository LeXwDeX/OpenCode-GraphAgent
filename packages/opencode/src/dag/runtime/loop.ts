export * as DagLoop from "./loop"

import { Effect, Layer, Context, Stream, Semaphore, Fiber, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowRuntime, type SchedulingNode } from "@opencode-ai/core/dag/core/scheduling"
import { isWorkflowTerminalStatus } from "@opencode-ai/core/dag/core/types"
import { Dag, type WorkflowConfig, parseWorkflowConfig } from "../dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { renderTemplate } from "../templates/resolve"
import { sanitizeInput } from "../templates/sanitize"
import { spawnNode } from "./spawn"
import { evaluateCondition, resolveInputMapping } from "./eval"
import { reconcileWorkflow, makeSessionStatusChecker } from "./recovery"

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DagLoop") {}

export const SUCCESS_TERMINAL = new Set(["completed", "skipped", "aborted"])

export function toSchedulingNodes(nodes: readonly DagStore.NodeRow[]): SchedulingNode[] {
  return nodes.map((n) => ({
    id: n.id,
    dependsOn: n.dependsOn,
    required: n.required,
    status: SUCCESS_TERMINAL.has(n.status)
      ? ("satisfied" as const)
      : n.status === "failed"
        ? ("unsatisfied" as const)
        : n.status === "running"
          ? ("running" as const)
          : ("pending" as const),
  }))
}

interface WorkflowEntry {
  runtime: WorkflowRuntime
  semaphore: Semaphore.Semaphore
  evalLock: Semaphore.Semaphore
  parentSessionID: string
  config: WorkflowConfig | undefined
  fibers: Map<string, Fiber.Fiber<unknown, unknown>>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service
    const dag = yield* Dag.Service
    const agentSvc = yield* Agent.Service
    const sessionSvc = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const statusSvc = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("DagLoop.state")(function* (ctx) {
        const runtimes = new Map<string, WorkflowEntry>()
        const wakeInFlight = new Set<string>()
        const wakePending = new Set<string>()

        const spawnReady = Effect.fn("DagLoop.spawnReady")(function* (dagID: string) {
          const entry = runtimes.get(dagID)
          if (!entry) return
          const ready = entry.runtime.getReadyNodes()
          for (const nodeID of ready) {
            const node = yield* store.getNode(dagID, nodeID)
            if (!node) continue
            const nodeConfig = entry.config?.nodes.find((n) => n.id === nodeID)

            if (nodeConfig?.condition) {
              const allNodes = yield* store.getNodes(dagID)
              const outputs: Record<string, unknown> = {}
              for (const dep of node.dependsOn) {
                const depNode = allNodes.find((n) => n.id === dep)
                if (depNode) outputs[dep] = { output: depNode.output }
              }
              const condResult = evaluateCondition(nodeConfig.condition, outputs)
              if (!condResult.ok) {
                yield* dag.nodeFailed(dagID, nodeID, condResult.error, "exec_failed").pipe(Effect.ignore)
                entry.runtime.markUnsatisfied(nodeID)
                continue
              }
              if (!condResult.value) {
                entry.runtime.markSatisfied(nodeID)
                yield* dag.nodeSkipped(dagID, nodeID, "condition_false").pipe(Effect.ignore)
                continue
              }
            }

            const promptParts: { type: "text"; text: string }[] = []

            let resolvedMapping: Record<string, unknown> = {}
            const inputMapping = nodeConfig?.input_mapping ?? Object.fromEntries(node.dependsOn.map((dependency) => [dependency, dependency]))
            if (Object.keys(inputMapping).length > 0) {
              const allNodes = yield* store.getNodes(dagID)
              resolvedMapping = resolveInputMapping(inputMapping, (depId) => {
                const depNode = allNodes.find((n) => n.id === depId)
                if (!depNode) return null
                if (depNode.output !== null) return depNode.output
                if (depNode.status === "failed") {
                  return `Dependency "${depId}" failed: ${depNode.errorReason ?? "unknown error"}`
                }
                if (depNode.status === "skipped") {
                  return `Dependency "${depId}" skipped: ${depNode.errorReason ?? "no output"}`
                }
                if (depNode.status === "aborted") return `Dependency "${depId}" aborted`
                if (depNode.status === "completed") return `Dependency "${depId}" completed without output`
                return null
              })
            }

            // Sanitize the dynamic node-output surface (LLM-generated upstream
            // outputs) before interpolation and Context serialization.
            resolvedMapping = sanitizeInput(resolvedMapping)

            const resolved = yield* (nodeConfig?.prompt_template
              ? renderTemplate(nodeConfig.prompt_template, ctx.directory, resolvedMapping).pipe(
                  Effect.tap((result) =>
                    result.text.trim() === ""
                      ? Effect.logWarning("DAG node resolved template is empty", { dagID, nodeID })
                      : Effect.void,
                  ),
                  Effect.map((result) => ({ ok: true as const, ...result })),
                  Effect.catch((err: unknown) =>
                    Effect.gen(function* () {
                      yield* dag.nodeFailed(dagID, nodeID, `Template resolution failed: ${String(err)}`, "exec_failed").pipe(Effect.ignore)
                      return { ok: false as const, text: "", unresolvedPlaceholders: [] }
                    }),
                  ),
                )
              : Effect.succeed({
                  ok: true as const,
                  text: node.name,
                  unresolvedPlaceholders: [],
                }))
            if (!resolved.ok) {
              entry.runtime.markUnsatisfied(nodeID)
              continue
            }

            if (resolved.unresolvedPlaceholders.length > 0) {
              yield* dag.nodeFailed(
                dagID,
                nodeID,
                `Unresolved template placeholders: ${resolved.unresolvedPlaceholders.join(", ")}`,
                "verdict_fail",
              ).pipe(Effect.ignore)
              entry.runtime.markUnsatisfied(nodeID)
              continue
            }

            promptParts.push({ type: "text", text: resolved.text })

            if (Object.keys(resolvedMapping).length > 0) {
              promptParts.push({ type: "text", text: `\n\nContext:\n${JSON.stringify(resolvedMapping, null, 2)}` })
            }

            if (nodeConfig?.output_schema) {
              promptParts.push({
                type: "text",
                text: `\n\nYou MUST call the submit_result tool with a JSON payload matching this schema before ending your turn:\n${JSON.stringify(nodeConfig.output_schema, null, 2)}`,
              })
            }

            entry.runtime.markRunning(nodeID)
            const oldFiber = entry.fibers.get(nodeID)
            yield* abortChild(nodeID, node.childSessionId).pipe(Effect.ignore)
            if (oldFiber) yield* Fiber.interrupt(oldFiber).pipe(Effect.ignore)
            yield* spawnNode(entry.semaphore, {
              dagID,
              nodeID,
              node,
              parentSessionID: entry.parentSessionID,
              promptParts,
              outputSchema: nodeConfig?.output_schema as Record<string, unknown> | undefined,
              timeoutMs: nodeConfig?.worker_config?.timeout_ms,
              reportToParent: nodeConfig?.report_to_parent,
            }).pipe(
              Effect.tap((result) => Effect.sync(() => entry.fibers.set(nodeID, result.fiber))),
              Effect.provideService(Dag.Service, dag),
              Effect.provideService(Agent.Service, agentSvc),
              Effect.provideService(Session.Service, sessionSvc),
              Effect.provideService(SessionPrompt.Service, promptSvc),
              Effect.catchCause((cause) =>
                dag.nodeFailed(dagID, nodeID, String(cause), "exec_failed"),
              ),
              Effect.ignore,
            )
          }
        })

        const checkCompletion = Effect.fn("DagLoop.checkCompletion")(function* (dagID: string) {
          const entry = runtimes.get(dagID)
          if (!entry) return
          if (!entry.runtime.isComplete()) return
          const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
          if (wf && isWorkflowTerminalStatus(wf.status as never)) return
          if (entry.runtime.hasRequiredFailure()) yield* dag.cancel(dagID)
          else yield* dag.complete(dagID)
        })

        const checkSessionStatus = makeSessionStatusChecker(sessionSvc)

        // Best-effort abort of a durable child session, independent of whether
        // a local wrapper fiber still exists.  Used at every replacement,
        // cancellation, failure, and workflow-terminal cleanup site.
        const abortChild = Effect.fnUntraced(function* (nodeID: string, childSessionId: string | null) {
          if (!childSessionId) return
          yield* promptSvc.cancel(childSessionId as never).pipe(Effect.ignore)
        })

        const recoverWorkflow = Effect.fn("DagLoop.recoverWorkflow")(function* (wf: DagStore.WorkflowRow) {
          const dagID = wf.id
          const config = parseWorkflowConfig(wf.config)
          const recovery = yield* reconcileWorkflow(
            dagID,
            checkSessionStatus,
            (sid) => promptSvc.cancel(sid as never),
            config,
          ).pipe(
            Effect.provideService(Dag.Service, dag),
          )
          if (recovery.ownershipLost > 0) {
            yield* Effect.logWarning("DagLoop terminalized recovered nodes after execution ownership loss", {
              dagID,
              reconciled: recovery.reconciled,
              ownershipLost: recovery.ownershipLost,
            })
          }
          const nodes = yield* store.getNodes(dagID)
          const maxConcurrency = Math.max(1, config?.max_concurrency ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxConcurrency)
          const runtime = new WorkflowRuntime(toSchedulingNodes(nodes), maxConcurrency)
          const semaphore = Semaphore.makeUnsafe(maxConcurrency)
          const isPaused = wf.status === "paused"
          const isStepping = wf.status === "stepping"
          if (isPaused) runtime.setPaused(true)
          if (isStepping) runtime.setStepMode(true)
          const entry: WorkflowEntry = { runtime, semaphore, evalLock: Semaphore.makeUnsafe(1), parentSessionID: wf.sessionId, config, fibers: new Map() }
          runtimes.set(dagID, entry)
          // Reconciliation settles every persisted running attempt before the
          // runtime is rebuilt. Recovery never adopts or restarts provider work;
          // a new execution attempt must come from explicit workflow control.
          if (!isPaused && !isStepping) {
            yield* entry.evalLock.withPermits(1)(
              Effect.gen(function* () {
                yield* spawnReady(dagID)
                yield* checkCompletion(dagID)
              }),
            )
          }
        })

        yield* events.subscribe(DagEvent.WorkflowStarted).pipe(
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              if (runtimes.has(dagID)) return
              const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
              if (!wf) return
              const config = parseWorkflowConfig(wf.config)
              const nodes = yield* store.getNodes(dagID)
              const maxConcurrency = Math.max(1, config?.max_concurrency ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxConcurrency)
              const runtime = new WorkflowRuntime(toSchedulingNodes(nodes), maxConcurrency)
              const semaphore = Semaphore.makeUnsafe(maxConcurrency)
              const entry: WorkflowEntry = { runtime, semaphore, evalLock: Semaphore.makeUnsafe(1), parentSessionID: wf.sessionId, config, fibers: new Map() }
              runtimes.set(dagID, entry)
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  yield* spawnReady(dagID)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        for (const def of [DagEvent.NodeCompleted, DagEvent.NodeSkipped]) {
          yield* events.subscribe(def).pipe(
            Stream.filter((e) => runtimes.has(e.data.dagID as string)),
            Stream.runForEach((evt) =>
              Effect.gen(function* () {
                const dagID = evt.data.dagID as string
                const entry = runtimes.get(dagID)
                if (!entry) return
                yield* entry.evalLock.withPermits(1)(
                  Effect.gen(function* () {
                    entry.fibers.delete(evt.data.nodeID as string)
                    const workflow = yield* store.getWorkflow(dagID)
                    entry.runtime.setPaused(workflow?.status === "paused")
                    entry.runtime.setStepMode(workflow?.status === "stepping")
                    // Guard against stale events: a node already cancelled
                    // (markUnsatisfied) or already satisfied must not be flipped
                    // back. Mirrors the NodeFailed handler's isActive guard.
                    if (entry.runtime.isActive(evt.data.nodeID as string)) {
                      entry.runtime.markSatisfied(evt.data.nodeID as string)
                      // In stepMode, do NOT auto-advance — wait for the next
                      // explicit step command. checkCompletion still runs so
                      // required-node failure / early completion is detected.
                      if (!entry.runtime.isStepMode()) yield* spawnReady(dagID)
                    }
                    yield* checkCompletion(dagID)
                  }),
                )
                // P1-2: trigger wake check directly on node terminal —
                // the parent session may already be idle (no new idle event
                // will fire), so we can't rely on the idle subscription alone.
                yield* tryDeliverWake(entry.parentSessionID).pipe(Effect.ignore, Effect.forkScoped)
              }).pipe(Effect.ignore),
            ),
            Effect.forkScoped({ startImmediately: true }),
          )
        }

        yield* events.subscribe(DagEvent.NodeCancelled).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              const nodeID = evt.data.nodeID as string
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  const fiber = entry.fibers.get(nodeID)
                  const node = yield* store.getNode(dagID, nodeID)
                  yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                  if (fiber) {
                    yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                    entry.fibers.delete(nodeID)
                  }
                  entry.runtime.markUnsatisfied(nodeID)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* events.subscribe(DagEvent.NodeFailed).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
            Stream.runForEach((evt) =>
              Effect.gen(function* () {
                const dagID = evt.data.dagID as string
                const entry = runtimes.get(dagID)
                if (!entry) return
                yield* entry.evalLock.withPermits(1)(
                  Effect.gen(function* () {
                    const nid = evt.data.nodeID as string
                    const fiber = entry.fibers.get(nid)
                    entry.fibers.delete(nid)
                    // #3: only markUnsatisfied if the runtime still tracks this
                    // node as non-terminal. A stale NodeFailed event (e.g. from
                    // a replan-ceiling check after the node already completed)
                    // would incorrectly flip a satisfied node to unsatisfied.
                    if (entry.runtime.isActive(nid)) {
                      const node = yield* store.getNode(dagID, nid)
                      yield* abortChild(nid, node?.childSessionId ?? null).pipe(Effect.ignore)
                      if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                      entry.runtime.markUnsatisfied(nid)
                    }
                    // In stepMode, checkCompletion (which can trigger autonomous
                    // fail/complete) still runs, but spawnReady is skipped —
                    // stepping must NOT auto-advance after a node fails.
                    yield* checkCompletion(dagID)
                  }),
                )
                yield* tryDeliverWake(entry.parentSessionID).pipe(Effect.ignore, Effect.forkScoped)
              }).pipe(Effect.ignore),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* events.subscribe(DagEvent.WorkflowPaused).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const entry = runtimes.get(evt.data.dagID as string)
              if (!entry) return
              yield* entry.evalLock.withPermits(1)(Effect.sync(() => entry.runtime.setPaused(true)))
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* events.subscribe(DagEvent.WorkflowStepped).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  entry.runtime.setStepMode(true)
                  yield* spawnReady(dagID)
                }),
              )
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* events.subscribe(DagEvent.WorkflowResumed).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  entry.runtime.setPaused(false)
                  entry.runtime.setStepMode(false)
                  yield* spawnReady(dagID)
                }),
              )
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* events.subscribe(DagEvent.WorkflowReplanned).pipe(
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) {
                const workflow = yield* store.getWorkflow(dagID)
                if (workflow) yield* recoverWorkflow(workflow)
                return
              }
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
                  if (wf) entry.config = parseWorkflowConfig(wf.config)
                  const nodes = yield* store.getNodes(dagID)
                  entry.runtime.rebuildGraph(toSchedulingNodes(nodes))
                  yield* spawnReady(dagID)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        for (const def of [DagEvent.WorkflowCompleted, DagEvent.WorkflowFailed, DagEvent.WorkflowCancelled]) {
          yield* events.subscribe(def).pipe(
            Stream.filter((e) => runtimes.has(e.data.dagID as string)),
            Stream.runForEach((evt) =>
              Effect.gen(function* () {
                const dagID = evt.data.dagID as string
                const entry = runtimes.get(dagID)
                const parentSessionID = entry?.parentSessionID
                if (entry) {
                  yield* entry.evalLock.withPermits(1)(
                    Effect.gen(function* () {
                      for (const [nodeID, fiber] of entry.fibers) {
                        const node = yield* store.getNode(dagID, nodeID)
                        yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                        yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                      }
                      entry.fibers.clear()
                      runtimes.delete(dagID)
                    }),
                  )
                }
                // P1-6: trigger wake on workflow terminal so the parent
                // learns the final outcome even if no idle event fires.
                if (parentSessionID) {
                  yield* tryDeliverWake(parentSessionID).pipe(Effect.ignore, Effect.forkScoped)
                }
              }).pipe(Effect.ignore),
            ),
            Effect.forkScoped({ startImmediately: true }),
          )
        }

        // ── D2+D7: Autonomous wake — extracted as reusable function ────
        // Called from both the idle-event subscription AND node-terminal
        // event handlers, so a wake fires even when the parent session is
        // already idle (P1-2 fix).

        const readWakeBatch = Effect.fn("DagLoop.readWakeBatch")(function* (sessionID: string) {
          const snapshot = yield* store.getWakeSnapshot(sessionID).pipe(
            Effect.catch(() =>
              Effect.succeed({ nodes: [], workflows: [] } satisfies DagStore.WakeSnapshot),
            ),
          )
          const terminalWorkflows = snapshot.workflows.filter(
            (workflow) => !workflow.wakeReported && isWorkflowTerminalStatus(workflow.status as never),
          )
          const workflowIDs = [...new Set([
            ...snapshot.nodes.map((node) => node.workflowId),
            ...terminalWorkflows.map((workflow) => workflow.id),
          ])]
          const workflowsByID = new Map(snapshot.workflows.map((workflow) => [workflow.id, workflow]))
          const workflows = workflowIDs.map((workflowID) => workflowsByID.get(workflowID))
          const boundaryWorkflows = workflows.filter((workflow): workflow is DagStore.WorkflowRow => {
            if (!workflow) return false
            if (isWorkflowTerminalStatus(workflow.status as never)) return true
            const entry = runtimes.get(workflow.id)
            if (workflow.status === "paused" || workflow.status === "stepping") return true
            if (entry?.runtime.isPaused() || entry?.runtime.isStepMode()) return true
            if (workflow.status !== "running" || !entry) return false
            if (entry.runtime.hasRunningMatching((id) => entry.fibers.has(id))) return false
            return entry.runtime.getReadyNodes().length === 0
          })
          const atBoundary = new Set(boundaryWorkflows.map((workflow) => workflow.id))
          const batch = {
            nodes: snapshot.nodes.filter((node) => atBoundary.has(node.workflowId)),
            workflows: terminalWorkflows.filter((workflow) => atBoundary.has(workflow.id)),
          } satisfies DagStore.WakeBatch
          return {
            batch,
            actionableDagIDs: new Set(
              boundaryWorkflows
                .filter((workflow) => !isWorkflowTerminalStatus(workflow.status as never))
                .map((workflow) => workflow.id),
            ),
            unresponsiveDagIDs: new Set(
              boundaryWorkflows
                .filter((workflow) => {
                  const entry = runtimes.get(workflow.id)
                  return workflow.status === "running"
                    && !entry?.runtime.isPaused()
                    && !entry?.runtime.isStepMode()
                })
                .map((workflow) => workflow.id),
            ),
          }
        })

        let tryDeliverWake: (sessionID: string) => Effect.Effect<void> = () => Effect.void
        tryDeliverWake = Effect.fn("DagLoop.tryDeliverWake")(function* (sessionID: string) {
          if (wakeInFlight.has(sessionID)) {
            wakePending.add(sessionID)
            return
          }
          wakeInFlight.add(sessionID)
          // Re-read after each stable batch so rows committed during delivery
          // remain a separate batch.
          try {
            const deliveredUnresponsiveDagIDs = new Set<string>()
            for (;;) {
              const plan = yield* readWakeBatch(sessionID)
              const batch = plan.batch
              const hasUnreported = batch.nodes.length > 0 || batch.workflows.length > 0

              if (!hasUnreported) {
                // A terminal event can commit between either query. Coalesce
                // its trigger into another durable read before declaring idle.
                if (wakePending.delete(sessionID)) continue
                // D7: if we delivered at least one wake in this call and no more
                // unreported rows remain, check for orchestrator-unresponsive.
                // #5: scoped per-workflow — only fail the workflow whose node
                // was reported, not any other workflow under the same session.
                // Skip paused and stepping workflows; both can intentionally
                // have no ready nodes.
                if (deliveredUnresponsiveDagIDs.size > 0) {
                  for (const dagID of deliveredUnresponsiveDagIDs) {
                    const entry = runtimes.get(dagID)
                    if (!entry) continue
                    if (entry.runtime.isPaused() || entry.runtime.isStepMode()) continue
                    // Suppress the net only when current-process execution
                    // ownership proves that a running node is making progress.
                    if (entry.runtime.hasRunningMatching((id) => entry.fibers.has(id))) continue
                    if (entry.runtime.getReadyNodes().length > 0) continue
                    if (entry.runtime.isComplete()) continue
                    yield* dag.fail(dagID, "orchestrator_unresponsive").pipe(Effect.ignore)
                  }
                }
                return
              }

              if ((yield* statusSvc.get(SessionID.make(sessionID))).type !== "idle") return

              // Preemption guard (task 3.3): abort if fresher user message exists
              const msgs = yield* sessionSvc.messages({ sessionID: SessionID.make(sessionID), limit: 20 }).pipe(Effect.catch(() => Effect.succeed([])))
              let lastUserAt = -1
              let lastAsstAt = -1
              for (const m of msgs) {
                const t = m.info.time?.created
                if (typeof t !== "number") continue
                if (m.info.role === "user" && t > lastUserAt) lastUserAt = t
                else if (m.info.role === "assistant" && t > lastAsstAt) lastAsstAt = t
              }
              if (lastUserAt > lastAsstAt) return

              const summaries = [
                ...batch.nodes.map((node) => {
                  const output = typeof node.output === "string"
                    ? node.output.slice(0, 500)
                    : node.errorReason ?? (node.output == null ? "(no output)" : JSON.stringify(node.output).slice(0, 500))
                  return `[DAG Node Result] Node "${node.name}" ${node.status}: ${output}`
                }),
                ...batch.workflows.map(
                  (workflow) =>
                    `[DAG Workflow ${workflow.status}] Workflow "${workflow.title}" has reached terminal status.`,
                ),
              ]
              const summary = [
                ...summaries,
                ...(plan.actionableDagIDs.size > 0
                  ? ['You MUST act on these workflows in this turn (workflow tool: extend / control replan / complete / cancel). If this turn ends with a workflow stalled and no action taken, it will be failed with reason "orchestrator_unresponsive".']
                  : []),
              ].join("\n\n")

              // Persist wake_reported AFTER successful delivery only.
              // A failure stays durable for a later idle event or restart scan;
              // it must not spin synchronously on the same row.
              // The part is marked synthetic: model-visible (the orchestrator
              // receives the node result and can act) but NOT rendered as a user
              // message in the TUI chat — DAG data surfaces via the sidebar panel
              // and Inspector, keeping the chat conversation clean.
              const didDeliver = yield* promptSvc.promptIfIdle({
                sessionID: SessionID.make(sessionID),
                parts: [{ type: "text", text: summary, synthetic: true }],
              }).pipe(
                Effect.flatMap(Option.match({
                  onNone: () => Effect.succeed(false),
                  onSome: () =>
                    store.markWakeBatchReported(batch).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          plan.unresponsiveDagIDs.forEach((workflowID) =>
                            deliveredUnresponsiveDagIDs.add(workflowID),
                          )
                        }),
                      ),
                      Effect.as(true),
                    ),
                })),
                Effect.catchCause(() =>
                  Effect.logWarning("DAG wake delivery failed", { sessionID }).pipe(Effect.as(false)),
                ),
              )
              if (!didDeliver) return
            }
          } finally {
            const retry = wakePending.delete(sessionID)
            wakeInFlight.delete(sessionID)
            if (retry) yield* tryDeliverWake(sessionID)
          }
        })

        // Idle-event subscription: the primary wake trigger
        yield* events.subscribe(SessionStatusEvent.Status).pipe(
          Stream.filter((evt) => evt.data.status.type === "idle"),
          Stream.runForEach((evt) =>
            tryDeliverWake(evt.data.sessionID as string).pipe(Effect.ignore, Effect.forkScoped),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        // Install all live event handlers before spawning recovery watchers so
        // a child that settles immediately cannot leave the runtime stale.
        const runningWfs = yield* store.listByStatus("running").pipe(Effect.orDie)
        const pausedWfs = yield* store.listByStatus("paused").pipe(Effect.orDie)
        const steppingWfs = yield* store.listByStatus("stepping").pipe(Effect.orDie)
        for (const wf of [...runningWfs, ...pausedWfs, ...steppingWfs]) {
          yield* recoverWorkflow(wf).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DagLoop recovery failed for workflow", { dagID: wf.id, cause }),
            ),
          )
        }

        // Terminal rows can survive a process crash after projection but before
        // parent delivery. Re-enter the normal serialized drain for every
        // affected parent session without waiting for a new status event.
        const pendingWakeSessions = yield* store.getSessionsWithUnreportedWakes().pipe(
          Effect.catch(() => Effect.succeed([] as string[])),
        )
        for (const sessionID of pendingWakeSessions) {
          yield* tryDeliverWake(sessionID).pipe(Effect.forkScoped)
        }

        return {}
      }),
    )

    const init = Effect.fn("DagLoop.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(Dag.defaultLayer),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

export const node = LayerNode.make(layer, [
  EventV2Bridge.node,
  DagStore.node,
  Dag.node,
  Agent.node,
  Session.node,
  SessionPrompt.node,
  SessionStatus.node,
])
