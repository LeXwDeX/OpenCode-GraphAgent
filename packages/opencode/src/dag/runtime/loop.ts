// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagLoop from "./loop"

import { Cause, Effect, Layer, Context, Stream, Semaphore, Fiber, Option, DateTime, Clock, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagLocation } from "../location"
import { WorkflowRuntime, toSchedulingNodes } from "@opencode-ai/core/dag/core/scheduling"
import { isNodeTerminalStatus, isWorkflowTerminalStatus } from "@opencode-ai/core/dag/core/types"
import { Dag, type WorkflowConfig, parseWorkflowConfig } from "../dag"
import { projectBriefForNode } from "../admission"
import {
  reviewImplementationFingerprint,
  reviewContractForNode,
  validateReviewExecutionInput,
  reviewEvidenceKeys,
} from "../review-lifecycle"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionAutomationLease } from "@/session/automation-lease"
import { renderTemplate } from "../templates/resolve"
import { sanitizeInput } from "../templates/sanitize"
import { DagConfig } from "../config"
import { spawnNode, makeDeadlineWatcher } from "./spawn"
import { evaluateCondition, resolveInputMapping } from "./eval"
import { reconcileWorkflow, makeSessionStatusChecker, makeLastAssistantTextReader } from "./recovery"

// A reporting checkpoint's replan verdict vetoes the current direction: the
// workflow pauses durably before any downstream spawn (see NodeCompleted
// handler). Only the verdict shape matters — any node whose submitted output
// matches triggers the gate, so non-reporting nodes can never trip it.
const GateReplanVerdict = Schema.Struct({ verdict: Schema.Literal("replan") })
const parseJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DagLoop") {}

interface WorkflowEntry {
  runtime: WorkflowRuntime
  semaphore: Semaphore.Semaphore
  evalLock: Semaphore.Semaphore
  parentSessionID: string
  config: WorkflowConfig | undefined
  fibers: Map<string, Fiber.Fiber<unknown, unknown>>
  watchers: Map<string, Fiber.Fiber<unknown, unknown>>
  /** DAG-03/F2: a replan-verdict veto whose durable pause could not be
   * persisted. While set, the in-memory paused flag survives the durable-row
   * re-syncs performed by node terminal events and refreshControlFlags, so
   * no stimulus spawns the vetoed direction before the parent acts. Released
   * by the parent's explicit control events — replan and step are reachable
   * from every hold state; resume only when the durable row is not running
   * (paused/stepping — a held row reads "running" and resume is an invalid
   * transition there until a durable pause lands; control(replan) is the
   * disposition the verdict asked for). Process-local: a restart while the
   * durable pause never landed rebuilds the flags from the durable row (the
   * audit's DAG-03 scope was the in-process fail-open, which this closes). */
  vetoHold: boolean
}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service
    const dag = yield* Dag.Service
    const agentSvc = yield* Agent.Service
    const sessionSvc = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const statusSvc = yield* SessionStatus.Service
    const automation = yield* SessionAutomationLease.Service

    const state = yield* InstanceState.make(
      Effect.fn("DagLoop.state")(function* (ctx) {
        const runtimes = new Map<string, WorkflowEntry>()
        // Adoption in-flight reservations: recoverWorkflow spans async yield
        // points before it publishes its entry into `runtimes`, so a plain
        // runtimes.has check is check-then-act. Reserved synchronously at
        // adoption entry, released when the adoption settles.
        const recovering = new Set<string>()
        const wakeInFlight = new Set<string>()
        const wakePending = new Set<string>()
        // Per-session record of the last wake summary whose transcript part was
        // written. Admit success IS the delivery (issue #321): the durable
        // wake_reported mark lands immediately after the write, not after the
        // wake-driven turn completes, so the in-memory map only needs to dedupe
        // the narrow mark-retry path — if the leased mark returns None the rows
        // stay unreported and a later trigger re-marks WITHOUT re-prompting.
        // In-process only; restart durability now comes from wake_reported being
        // persisted at admit time, not from this map. Capped: evicting entries
        // degrades to a redundant re-prompt, never to a lost wake.
        const deliveredWakeSummaries = new Map<string, string>()

        // Seed the commented global dag.jsonc once per instance init — the
        // per-round DagConfig.load below stays a pure read so the spawn
        // scheduling hot path never writes to the user's config dir.
        yield* DagConfig.load(ctx.directory, { autoSeed: true }).pipe(Effect.ignore)

        const spawnReady = Effect.fn("DagLoop.spawnReady")(function* (dagID: string) {
          const entry = runtimes.get(dagID)
          if (!entry) return
          // P2-C execution-location revalidation: every spawn call site funnels
          // through here. A workflow whose durable identity was repainted
          // (identity migration) or cascade-deleted must not keep scheduling
          // children under this instance's directory context — drop the stale
          // entry so no later stimulus acts on it either (its watchers
          // self-exit on terminal rows; its prompt fibers finish naturally).
          if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) {
            runtimes.delete(dagID)
            return
          }
          // D13: settle cascade-skips before spawning. A node whose dependencies
          // are all skipped can never receive a real input; publish a durable
          // NodeSkipped(orphan_cascade) wave by wave until a fixpoint so gated
          // subtrees terminalize instead of running on placeholder inputs.
          // Eagerly markSkipped so the fixpoint advances synchronously; the
          // NodeSkipped handler's isActive guard then no-ops on these events.
          for (;;) {
            const cascade = entry.runtime.getCascadeSkipNodes()
            if (cascade.length === 0) break
            for (const nodeID of cascade) {
              entry.runtime.markSkipped(nodeID)
              yield* dag.nodeSkipped(dagID, nodeID, "orphan_cascade").pipe(Effect.ignore)
            }
          }
          const ready = entry.runtime.getReadyNodes()
          // P1-3: one snapshot per scheduling round. Every ready node's
          // dependencies are already terminal (that's what made it ready), so
          // their outputs cannot change during this loop — per-node re-reads
          // were O(ready × nodes) pure overhead.
          const nodesSnapshot = ready.length > 0 ? yield* store.getNodes(dagID) : []
          // dag.jsonc defaults are read once per scheduling round (lazy, like
          // templates) so edits apply to the next round without a restart.
          const dagConfig: DagConfig.Info = ready.length > 0 ? yield* DagConfig.load(ctx.directory) : {}
          for (const nodeID of ready) {
            const node = nodesSnapshot.find((n) => n.id === nodeID)
            if (!node) continue
            const nodeConfig = entry.config?.nodes.find((n) => n.id === nodeID)

            if (nodeConfig?.condition) {
              const outputs: Record<string, unknown> = {}
              for (const dep of node.dependsOn) {
                const depNode = nodesSnapshot.find((n) => n.id === dep)
                if (!depNode) continue
                // DAG-01: a schema-less checkpoint completes with a raw
                // string output. Normalize JSON strings before condition
                // evaluation so `.output.<field>` gates read the parsed
                // structure instead of resolving undefined — pre-fix the
                // equality gate was permanently false, every gated dependent
                // was skipped as condition_false, and checkCompletion still
                // reported the workflow COMPLETED (silent half-graph loss).
                // Mirrors the replan-verdict gate's parseJsonOption
                // normalization in the NodeCompleted handler below (issue
                // #322). Non-JSON strings fall back to the raw value:
                // whole-output equality still works, field paths stay
                // undefined (documented condition_false), and numeric
                // comparisons keep their loud failure.
                outputs[dep] = {
                  output: typeof depNode.output === "string"
                    ? Option.getOrElse(parseJsonOption(depNode.output), () => depNode.output)
                    : depNode.output,
                }
              }
              const condResult = evaluateCondition(nodeConfig.condition, outputs)
              if (!condResult.ok) {
                yield* dag.nodeFailed(dagID, nodeID, condResult.error, "exec_failed").pipe(Effect.ignore)
                continue
              }
              if (!condResult.value) {
                yield* dag.nodeSkipped(dagID, nodeID, "condition_false").pipe(Effect.ignore)
                continue
              }
            }

            const promptParts: { type: "text"; text: string }[] = []

            let resolvedMapping: Record<string, unknown> = {}
            const inputMapping = nodeConfig?.input_mapping ?? Object.fromEntries(node.dependsOn.map((dependency) => [dependency, dependency]))
            if (Object.keys(inputMapping).length > 0) {
              resolvedMapping = resolveInputMapping(inputMapping, (depId) => {
                const depNode = nodesSnapshot.find((n) => n.id === depId)
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
            // outputs) before interpolation and Context serialization. Review
            // implementation evidence (diff/patch artifacts) is exempted —
            // wrapped, not rewritten — so the reviewer sees the real diff (P1-2).
            resolvedMapping = sanitizeInput(resolvedMapping, nodeConfig ? reviewEvidenceKeys(nodeConfig) : undefined)

            if (nodeConfig) {
              const reviewInput = validateReviewExecutionInput(nodeConfig, resolvedMapping)
              if (!reviewInput.valid) {
                yield* dag.nodeFailed(
                  dagID,
                  nodeID,
                  `Review input contract failed: ${reviewInput.errors.join("; ")}`,
                  "verdict_fail",
                ).pipe(Effect.ignore)
                continue
              }
            }

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
            if (!resolved.ok) continue

            if (resolved.unresolvedPlaceholders.length > 0) {
              yield* dag.nodeFailed(
                dagID,
                nodeID,
                `Unresolved template placeholders: ${resolved.unresolvedPlaceholders.join(", ")}`,
                "verdict_fail",
              ).pipe(Effect.ignore)
              continue
            }

            promptParts.push({ type: "text", text: resolved.text })

            const reviewContract = nodeConfig ? reviewContractForNode(nodeConfig) : undefined
            if (reviewContract) {
              promptParts.push({ type: "text", text: `\n\n${reviewContract}` })
            }

            if (entry.config?.mode === "deep" && entry.config.admission) {
              promptParts.push({
                type: "text",
                text: `\n\nRequirement Brief:\n${JSON.stringify(projectBriefForNode(entry.config.admission.brief), null, 2)}`,
              })
            }

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
            const oldWatcher = entry.watchers.get(nodeID)
            yield* abortChild(nodeID, node.childSessionId).pipe(Effect.ignore)
            if (oldFiber) yield* Fiber.interrupt(oldFiber).pipe(Effect.ignore)
            // Interrupt the old watcher BEFORE spawning a new one — otherwise
            // the old self-renewing watcher survives as a phantom (it is
            // unreachable from the map after the overwrite below) and keeps
            // escalating against the stale deadline, double-counting
            // timeout_extensions and sending duplicate wake notifications.
            if (oldWatcher) yield* Fiber.interrupt(oldWatcher).pipe(Effect.ignore)
            yield* spawnNode(entry.semaphore, {
              dagID,
              nodeID,
              node,
              parentSessionID: entry.parentSessionID,
              directory: ctx.directory,
              promptParts,
              outputSchema: nodeConfig?.output_schema as Record<string, unknown> | undefined,
              timeoutMs: nodeConfig?.worker_config?.timeout_ms,
              reportToParent: nodeConfig?.report_to_parent,
              reviewImplementationFingerprint: nodeConfig
                ? reviewImplementationFingerprint(nodeConfig, resolvedMapping)
                : undefined,
              fallbackModel: DagConfig.tierModel(dagConfig, { required: node.required, workerType: node.workerType }),
              variant: dagConfig.thinking_depth,
              maxTimeoutExtensions: entry.config?.max_timeout_extensions ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions,
            }).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  entry.fibers.set(nodeID, result.fiber)
                  entry.watchers.set(nodeID, result.watcherFiber)
                }),
              ),
              Effect.provideService(Dag.Service, dag),
              Effect.provideService(Agent.Service, agentSvc),
              Effect.provideService(Session.Service, sessionSvc),
              Effect.provideService(SessionPrompt.Service, promptSvc),
              Effect.catchCause((cause) =>
                dag.nodeFailed(dagID, nodeID, Cause.pretty(cause), "exec_failed"),
              ),
              Effect.ignore,
            )
          }
        })

        const checkCompletion = Effect.fn("DagLoop.checkCompletion")(function* (dagID: string) {
          const entry = runtimes.get(dagID)
          if (!entry) return
          if (!entry.runtime.isComplete()) return
          // Replan registers replacement nodes before cancelling nodes from the
          // old runtime graph. Event types are consumed independently, so the
          // cancellation handler can reach this point before WorkflowReplanned
          // rebuilds the in-memory graph. Durable active nodes prove that the
          // apparent completion belongs to an obsolete graph generation.
          // Rev-view (v1.0.15 Train A): the guard read filters to the current
          // revision — superseded rows are terminal and never trip the guard,
          // and the review-outcome input below must judge only current nodes.
          const nodes = yield* store.getCurrentNodes(dagID)
          const hasUnseenActiveNode = nodes.some(
            (node) => !isNodeTerminalStatus(node.status as never) && !entry.runtime.containsNode(node.id),
          )
          if (hasUnseenActiveNode) return
          // R6 identity revalidation: the ownership predicate re-reads the
          // durable row on every check. A workflow whose durable identity was
          // repainted (identity migration) or whose location moved away no
          // longer belongs to this in-memory entry — the stale entry must not
          // publish a workflow transition (complete/fail) for it.
          if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) return
          const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
          if (wf && isWorkflowTerminalStatus(wf.status as never)) return
          // A required-node failure is a workflow FAILURE, not a cancellation —
          // "cancelled" is reserved for explicit user/agent cancels so the
          // terminal status attributes the outcome correctly (P2-1).
          if (entry.runtime.hasRequiredFailure()) {
            yield* dag.fail(dagID, `required node(s) failed: ${entry.runtime.getRequiredFailures().join(", ")}`)
            return
          }
          // Unresolved review outcomes terminalize the graph as COMPLETED at
          // the checkpoint, not as a failure: the REJECT shape (skipped
          // dependents, reporting leaf) is exactly what reopen-extend is
          // designed to pick up, and a failed workflow is immutable
          // (issue #294). Explicit completion shortcuts keep the review gate.
          yield* dag.complete(dagID, { skipReviewGate: true })
        })

        const checkSessionStatus = makeSessionStatusChecker(sessionSvc)
        // #345: schemaless recovered nodes settle with the child's last
        // assistant text, mirroring the live spawn path.
        const lastAssistantText = makeLastAssistantTextReader(sessionSvc)

        // Best-effort abort of a durable child session, independent of whether
        // a local wrapper fiber still exists.  Used at every replacement,
        // cancellation, failure, and workflow-terminal cleanup site.
        const abortChild = Effect.fnUntraced(function* (nodeID: string, childSessionId: string | null) {
          if (!childSessionId) return
          yield* promptSvc.cancel(childSessionId as never).pipe(Effect.ignore)
        })

        // Subscription handlers must never die. dag.ts guards and checkCompletion
        // use orDie, whose defects punch straight through Effect.ignore (it only
        // absorbs the error channel) and would kill the forked runForEach fiber —
        // leaving that event type permanently unhandled for the rest of the
        // process. catchCause absorbs failures AND defects at the boundary.
        const guarded = (event: string) => <A, E, R>(self: Effect.Effect<A, E, R>) =>
          self.pipe(Effect.catchCause((cause) => Effect.logWarning("DagLoop handler failed", { event, cause })))

        const recoverWorkflow = Effect.fn("DagLoop.recoverWorkflow")(function* (wf: DagStore.WorkflowRow) {
          // Cross-instance guard: DagLoop is per-directory InstanceState but the
          // event bus and store are process-global. Only the instance whose
          // DIRECTORY owns the workflow may adopt it — otherwise a
          // multi-directory server spawns children under a foreign directory
          // context. The execution-location authority (dag/location.ts)
          // re-reads the durable row: the project id is a fast-reject, the
          // stamped directory is the deciding guard.
          if (!(yield* DagLocation.ownsWorkflow(wf.id, ctx.directory))) return
          const dagID = wf.id
          // Idempotency guard: the startup scan and the WorkflowReplanned
          // handler's re-adoption path can both reach here for the same
          // workflow (e.g. a replan call arriving while the scan is still
          // reconciling it). A duplicate adoption would reconcile twice and
          // overwrite the runtimes entry — orphaning the first entry's fibers
          // from every interrupt sweep. Reserve synchronously before the
          // first yield so the second caller drops out immediately.
          if (runtimes.has(dagID) || recovering.has(dagID)) return
          recovering.add(dagID)
          // Effect.ensuring releases the adoption slot even when a fiber
          // interrupt cuts the adoption sequence — a finally block does not
          // survive interruption.
          yield* Effect.gen(function* () {
            const config = parseWorkflowConfig(wf.config)
            const recovery = yield* reconcileWorkflow(
              dagID,
              checkSessionStatus,
              (sid) => promptSvc.cancel(sid as never),
              // null (not undefined) marks an unparseable row so recovery
              // fails such nodes loudly instead of undefined-completing them.
              config ?? null,
              lastAssistantText,
            ).pipe(
              Effect.provideService(Dag.Service, dag),
            )
            // P2-2 recovery-pause: reconciliation invented failures (ownership
            // lost / no child session / deadline enforced offline) without any
            // durable proof of the child's outcome. Letting spawnReady cascade
            // skips and checkCompletion terminalize now would weld the workflow
            // into a terminal status the parent never sanctioned — and terminal
            // nodes are immutable, so replan could no longer rewire downstream.
            // Pause instead: pending nodes stay replannable, the durable
            // NodeFailed wake rows reach the parent at the paused delivery
            // boundary, and disposition (replan / resume / cancel) stays under
            // explicit workflow control.
            const pausedForRecovery = recovery.ownershipLost > 0 && wf.status === "running"
            if (pausedForRecovery) {
              // A concurrent control op (cancel/fail) can terminalize the
              // workflow while reconciliation runs — the pause guard then
              // rejects. Abandon adoption instead of tracking a workflow this
              // instance no longer controls.
              const pauseAccepted = yield* dag.pause(dagID).pipe(
                Effect.as(true),
                Effect.catchCause((cause) =>
                  Effect.logWarning("DagLoop recovery pause rejected — abandoning adoption", { dagID, cause }).pipe(
                    Effect.as(false),
                  ),
                ),
              )
              if (!pauseAccepted) return
              yield* Effect.logWarning("DagLoop paused workflow after recovery invented node failures", {
                dagID,
                reconciled: recovery.reconciled,
                ownershipLost: recovery.ownershipLost,
              })
            }
            if (recovery.ownershipLost > 0 && !pausedForRecovery) {
              yield* Effect.logWarning("DagLoop terminalized recovered nodes after execution ownership loss", {
                dagID,
                reconciled: recovery.reconciled,
                ownershipLost: recovery.ownershipLost,
              })
            }
            // Rev-view (v1.0.15 Train A): the recovery runtime rebuilds from
            // the CURRENT graph revision — a crash must not revive the
            // replaced segment's failures (same rebuild input as the
            // WorkflowReplanned handler). Durable truth (the unfiltered read
            // in recovery reconcile above) is untouched.
            const nodes = yield* store.getCurrentNodes(dagID)
            const maxConcurrency = Math.max(1, config?.max_concurrency ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxConcurrency)
            const runtime = new WorkflowRuntime(toSchedulingNodes(nodes), maxConcurrency)
            const semaphore = Semaphore.makeUnsafe(maxConcurrency)
            const isPaused = wf.status === "paused" || pausedForRecovery
            const isStepping = wf.status === "stepping"
            if (isPaused) runtime.setPaused(true)
            if (isStepping) runtime.setStepMode(true)
            const entry: WorkflowEntry = { runtime, semaphore, evalLock: Semaphore.makeUnsafe(1), parentSessionID: wf.sessionId, config, fibers: new Map(), watchers: new Map(), vetoHold: false }
            // P2-E deletion-race re-check: the SessionV1.Event.Deleted sweep
            // only removes entries already published into `runtimes`. If the
            // FK cascade deleted this workflow's row while reconciliation ran,
            // publishing now would leak an inert entry the sweep can no longer
            // reach. The ensuring below still clears the recovering reservation.
            if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) return
            // #270 atomic-admission fence (C3): the durable read above and the
            // runtimes publish below are still two statements — a deletion can
            // commit between them. Collapse the admission into ONE conditional
            // UPDATE that matches only while the row exists and is non-terminal.
            // A cascade committed in that final window matches zero rows and the
            // adoption aborts here, before it ever publishes an entry.
            if (!(yield* store.tryClaimAdoption(dagID))) return
            runtimes.set(dagID, entry)
            yield* automation.register(SessionID.make(wf.sessionId), { kind: "dag", id: dagID })
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
            // Deliver the invented-failure wake rows now instead of waiting for
            // the next idle event — the workflow just paused itself and the
            // parent is the only actor that can dispose of it.
            if (pausedForRecovery) {
              yield* tryDeliverWake(wf.sessionId).pipe(Effect.ignore, Effect.forkScoped)
            }
          }).pipe(Effect.ensuring(Effect.sync(() => recovering.delete(dagID))))
        })

        // Orphan-pending recovery: a pending workflow with no non-pending node
        // is a create sequence that crashed mid-way — Dag.create publishes
        // WorkflowCreated + NodeRegistered + WorkflowStarted in separate
        // transactions, so a crash between them leaves a row whose start event
        // never arrives. PENDING→RUNNING is its only legal transition
        // (core/dag/core/types.ts), so nothing else can ever move it — without
        // this sweep the workflow hangs in pending forever. Terminalize via the
        // legal pending→running→failed sequence: the projector accepts
        // WorkflowFailed only from running/stepping (core/dag/projector.ts), so
        // a bare fail would be silently dropped. Failed (not cancelled) matches
        // the interrupted-create semantics and persists the reason in the
        // durable WorkflowFailed event; cancelled is reserved for explicit
        // user/agent cancels (see the checkCompletion attribution comment).
        const recoverOrphanPending = Effect.fn("DagLoop.recoverOrphanPending")(function* (wf: DagStore.WorkflowRow) {
          // Same cross-instance guard as recoverWorkflow, through the same
          // execution-location authority: only the instance whose DIRECTORY
          // owns the workflow may dispose of the orphan.
          if (!(yield* DagLocation.ownsWorkflow(wf.id, ctx.directory))) return
          const dagID = wf.id
          if (runtimes.has(dagID) || recovering.has(dagID)) return
          // Reserve the adoption slot for the whole terminalization sequence:
          // the WorkflowStarted leg is a real event on the bus, and the
          // WorkflowStarted handler must not adopt the orphan mid-sequence
          // (a zero-node orphan would be checkCompleted straight to
          // "completed" instead of being failed with the recovery reason).
          // Effect.ensuring releases the slot even when a fiber interrupt cuts
          // the sequence — a finally block does not survive interruption.
          recovering.add(dagID)
          yield* Effect.gen(function* () {
            const nodes = yield* store.getNodes(dagID)
            // Defensive no-miss-kill criterion: any non-pending node proves the
            // workflow was adopted and progressed — it is mid-flight, not
            // orphaned. All-pending rows can only be interrupted creates, since
            // create() completes its start event within the same process.
            if (!nodes.every((node) => node.status === "pending")) return
            yield* events.publish(DagEvent.WorkflowStarted, { dagID: dagID as never, timestamp: yield* DateTime.now })
            // dag.fail guards running→failed, persists the reason in the durable
            // WorkflowFailed event, and terminalizes every pending node via
            // NodeSkipped — no node is ever scheduled.
            yield* dag.fail(dagID, "orphan pending workflow recovered at startup")
            yield* Effect.logWarning("DagLoop terminalized orphan pending workflow", { dagID })
          }).pipe(Effect.ensuring(Effect.sync(() => recovering.delete(dagID))))
        })

        yield* events.subscribe(DagEvent.WorkflowStarted).pipe(
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              // Adoption-in-flight reservations (recoverWorkflow and the
              // orphan-pending sweep) must suppress this handler too: the
              // orphan sweep publishes WorkflowStarted only to legalize its
              // pending→running→failed terminalization, and adopting the
              // orphan mid-sequence would start scheduling on a dead workflow.
              //
              // H1 (DAG-LOC-01): the handler also reserves the slot for
              // ITSELF — two concurrent WorkflowStarted events (e.g. a
              // duplicate publish racing the live handler) previously both
              // passed the guard above (neither reserves anything) and both
              // reached runtimes.set: the second overwrote the first entry,
              // orphaning its fibers/watchers from every interrupt sweep and
              // double-registering the automation lease. Reserve
              // synchronously right after the guard — no yield between the
              // check and the add, so the second event's guard sees the
              // reservation — and release via Effect.ensuring, exactly
              // mirroring recoverWorkflow / recoverOrphanPending. The latch
              // also supersedes the WorkflowReplanned no-entry re-adoption
              // race: a replan arriving mid-adoption drops out of
              // recoverWorkflow instead of overwriting this entry, and the
              // adoption's own getNodes reads the already-replanned rows.
              if (runtimes.has(dagID) || recovering.has(dagID)) return
              recovering.add(dagID)
              yield* Effect.gen(function* () {
                const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
                if (!wf) return
                // Status guard: the orphan-pending sweep publishes WorkflowStarted
                // only to legalize the pending→running leg of its terminalization
                // sequence. By the time the event reaches this handler the row is
                // already failed — adopting it would rebuild a runtime and start
                // scheduling nodes on a dead workflow. Accept running rows only.
                if (wf.status !== "running") return
                // Cross-instance guard via the execution-location authority:
                // only the instance whose DIRECTORY owns the workflow adopts
                // (see recoverWorkflow). First-wave spawns must not race across
                // directory contexts.
                if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) return
                const config = parseWorkflowConfig(wf.config)
                // Rev-view (v1.0.15 Train A): same current-revision rebuild
                // input as recoverWorkflow — adoption must not resurrect the
                // replaced segment's failures either.
                const nodes = yield* store.getCurrentNodes(dagID)
                const maxConcurrency = Math.max(1, config?.max_concurrency ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxConcurrency)
                const runtime = new WorkflowRuntime(toSchedulingNodes(nodes), maxConcurrency)
                const semaphore = Semaphore.makeUnsafe(maxConcurrency)
                const entry: WorkflowEntry = { runtime, semaphore, evalLock: Semaphore.makeUnsafe(1), parentSessionID: wf.sessionId, config, fibers: new Map(), watchers: new Map(), vetoHold: false }
                // P2-E deletion-race re-check (same window as recoverWorkflow):
                // the Deleted sweep only removes entries already in `runtimes`,
                // and getNodes above is an awaited yield a deletion can slip
                // through. A row cascade-deleted after the first guard must not
                // be adopted into an inert entry.
                if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) return
                // #270 atomic-admission fence (C3, same as recoverWorkflow): the
                // durable read and the runtimes publish are two statements a
                // deletion can slip between; collapse the admission into one
                // conditional UPDATE (exists + non-terminal). A cascade committed
                // in the final window matches zero rows and the adoption aborts.
                if (!(yield* store.tryClaimAdoption(dagID))) return
                runtimes.set(dagID, entry)
                yield* automation.register(SessionID.make(wf.sessionId), { kind: "dag", id: dagID })
                yield* entry.evalLock.withPermits(1)(
                  Effect.gen(function* () {
                    yield* spawnReady(dagID)
                    yield* checkCompletion(dagID)
                  }),
                )
              }).pipe(Effect.ensuring(Effect.sync(() => recovering.delete(dagID))))
            }).pipe(guarded("WorkflowStarted")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        for (const def of [DagEvent.NodeCompleted, DagEvent.NodeSkipped]) {
          // A completed node is an output-producing success; a skipped node is a
          // terminal no-output state that must stay distinguishable so pure-skip
          // descendants cascade instead of running (D13).
          const settle = def === DagEvent.NodeSkipped
            ? (entry: WorkflowEntry, nodeID: string) => entry.runtime.markSkipped(nodeID)
            : (entry: WorkflowEntry, nodeID: string) => entry.runtime.markSatisfied(nodeID)
          yield* events.subscribe(def).pipe(
            Stream.filter((e) => runtimes.has(e.data.dagID as string)),
            Stream.runForEach((evt) =>
              Effect.gen(function* () {
                const dagID = evt.data.dagID as string
                const entry = runtimes.get(dagID)
                if (!entry) return
                yield* entry.evalLock.withPermits(1)(
                  Effect.gen(function* () {
                    const nodeID = evt.data.nodeID as string
                    // Same DB cross-check as the NodeFailed handler: projection
                    // is transactional with publish, so a row that no longer
                    // matches the event's terminal status means a later
                    // restart/replan reset it — drop the stale event without
                    // touching the new generation's fiber.
                    const expected = def === DagEvent.NodeSkipped ? "skipped" : "completed"
                    const node = yield* store.getNode(dagID, nodeID)
                    const confirmed = node?.status === expected
                    if (confirmed) {
                      if (def === DagEvent.NodeSkipped) {
                        // Cancel-skip race: workflow-level cancel publishes NodeSkipped
                        // for running nodes, and this handler may win the cross-stream
                        // race against WorkflowCancelled. Deleting the fiber here
                        // uninterrupted would orphan it from the WorkflowCancelled
                        // sweep and the child session would keep running until its
                        // prompt finishes or times out. Stop it now, mirroring the
                        // NodeCancelled handler. Completed nodes keep the plain
                        // delete — their fiber published the event and is finishing.
                        const fiber = entry.fibers.get(nodeID)
                        if (fiber) {
                          yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                          yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                        }
                      }
                      // N3: interrupt the watcher on BOTH terminal events. A node
                      // re-timed via replan carries a REPLACED watcher in
                      // entry.watchers; the spawn-time cleanup only interrupts the
                      // original watcherFiber, so without this the replacement
                      // lingers until its deadline wake (≤ the extended timeout)
                      // before it re-reads a terminal row and exits.
                      const watcher = entry.watchers.get(nodeID)
                      if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                      entry.fibers.delete(nodeID)
                      entry.watchers.delete(nodeID)
                    }
                    if (!confirmed) {
                      yield* Effect.logDebug("DagLoop dropped stale node terminal event", { dagID, nodeID, expected, dbStatus: node?.status ?? "missing" })
                    }
                    const workflow = yield* store.getWorkflow(dagID)
                    // F2: honor the veto hold — a durable "running" row must
                    // not lift the fail-closed pause a verdict gate set.
                    entry.runtime.setPaused(workflow?.status === "paused" || entry.vetoHold)
                    entry.runtime.setStepMode(workflow?.status === "stepping")
                    // Guard against stale events: a node already cancelled
                    // (markUnsatisfied) or already satisfied must not be flipped
                    // back. Mirrors the NodeFailed handler's isActive guard.
                    if (confirmed && entry.runtime.isActive(nodeID)) {
                      settle(entry, nodeID)
                      const nodeConfig = entry.config?.nodes.find((n) => n.id === nodeID)
                      // A checkpoint output can arrive as a raw string (no
                      // output_schema, or a string-typed child reply); parse it
                      // before matching the verdict so a string-typed
                      // {"verdict":"replan"} cannot bypass the gate (the spin
                      // behind issue #322).
                      const gateOutput = typeof node?.output === "string"
                        ? Option.getOrUndefined(parseJsonOption(node.output))
                        : node?.output
                      const gateReplan = def === DagEvent.NodeCompleted
                        && nodeConfig?.report_to_parent === true
                        && Option.isSome(Schema.decodeUnknownOption(GateReplanVerdict)(gateOutput))
                      if (gateReplan) {
                        // Verdict gate (issue #322): a reporting checkpoint that
                        // submits verdict "replan" vetoes the direction. Pause
                        // durably BEFORE any spawn round so dependents can never
                        // run on the rejected direction; the parent is woken by
                        // the report_to_parent wake and control(replan) applies
                        // corrective nodes — a paused workflow resumes as part
                        // of replan (workflow tool) so corrections can run.
                        const paused = yield* Effect.gen(function* () {
                          // DAG-03: the checkpoint VETOED this direction — the
                          // pause must fail CLOSED. Pause can fail transiently
                          // (e.g. the workflow lock is held by a concurrent
                          // long replan); retry once, and if it still cannot
                          // be persisted, HOLD the in-memory pause anyway.
                          // Pre-fix this returned `wf?.status === "paused"` —
                          // fail-OPEN: it explicitly un-paused the runtime, so
                          // the next stimulus calling spawnReady (a NodeFailed
                          // handler, a step, a resume) spawned the vetoed
                          // direction with no gate, no pause, no diagnostic.
                          // catchCause (not catch): a DEFECT from dag.pause
                          // must fold into the same path — pre-fix it escaped
                          // to guarded() and dropped this whole handler, so
                          // the pause was never even attempted and the gate's
                          // own warning was lost. Interrupts (scope disposal)
                          // still propagate.
                          const attemptPause = dag.pause(dagID).pipe(
                            Effect.map(() => true),
                            Effect.catchCause((cause) =>
                              Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(false),
                            ),
                          )
                          if (yield* attemptPause) return true
                          if (yield* attemptPause) return true
                          const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
                          if (wf?.status !== "paused") {
                            // F2: record the hold so the durable-row re-syncs
                            // below (node terminal prologues, refreshControlFlags)
                            // cannot lift it until the parent acts.
                            entry.vetoHold = true
                            yield* Effect.logError(
                              "DagLoop pause on replan verdict failed — holding in-memory pause (fail-closed)",
                              { dagID, nodeID, durableStatus: wf?.status ?? "missing" },
                            )
                          }
                          return true
                        })
                        entry.runtime.setPaused(paused)
                        yield* Effect.logWarning("DagLoop paused workflow after gate verdict: replan", { dagID, nodeID })
                      }
                      // In stepMode, do NOT auto-advance — wait for the next
                      // explicit step command. checkCompletion still runs so
                      // required-node failure / early completion is detected.
                      if (!gateReplan && !entry.runtime.isStepMode()) yield* spawnReady(dagID)
                    }
                    yield* checkCompletion(dagID)
                  }),
                )
                // P1-2: trigger wake check directly on node terminal —
                // the parent session may already be idle (no new idle event
                // will fire), so we can't rely on the idle subscription alone.
                yield* tryDeliverWake(entry.parentSessionID).pipe(Effect.ignore, Effect.forkScoped)
              }).pipe(guarded(def === DagEvent.NodeSkipped ? "NodeSkipped" : "NodeCompleted")),
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
                  const watcher = entry.watchers.get(nodeID)
                  if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                  entry.watchers.delete(nodeID)
                  entry.runtime.markUnsatisfied(nodeID)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(guarded("NodeCancelled")),
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
                    // Generation arbitration via DB status: each projector runs
                    // INSIDE the durable publish transaction (core/dag/projector.ts),
                    // so by the time this handler consumes the event the row
                    // already reflects it. If the row is no longer "failed", a
                    // later NodeRestarted/replan reset the node — this event
                    // belongs to a previous generation and must not touch the
                    // new one (including the fiber map, which may already hold
                    // the new attempt's fiber). No generation field needed.
                    const node = yield* store.getNode(dagID, nid)
                    // #3: only markUnsatisfied if the runtime still tracks this
                    // node as non-terminal. A stale NodeFailed event (e.g. from
                    // a replan-ceiling check after the node already completed)
                    // would incorrectly flip a satisfied node to unsatisfied.
                    if (node?.status === "failed" && entry.runtime.isActive(nid)) {
                      const fiber = entry.fibers.get(nid)
                      const watcher = entry.watchers.get(nid)
                      entry.fibers.delete(nid)
                      entry.watchers.delete(nid)
                      yield* abortChild(nid, node.childSessionId ?? null).pipe(Effect.ignore)
                      if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                      if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                      entry.runtime.markUnsatisfied(nid)
                      if (!entry.runtime.isStepMode()) yield* spawnReady(dagID)
                    }
                    if (node?.status !== "failed") {
                      yield* Effect.logDebug("DagLoop dropped stale NodeFailed", { dagID, nodeID: nid, dbStatus: node?.status ?? "missing" })
                    }
                    // In stepMode, checkCompletion (which can trigger autonomous
                    // fail/complete) still runs, but spawnReady is skipped —
                    // stepping must NOT auto-advance after a node fails.
                    yield* checkCompletion(dagID)
                  }),
                )
                yield* tryDeliverWake(entry.parentSessionID).pipe(Effect.ignore, Effect.forkScoped)
              }).pipe(guarded("NodeFailed")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        // Timeout escalation: the node keeps RUNNING — the runtime needs no
        // state change. The event's only job is to wake the main agent so it
        // can adjudicate (extend via replan with a new timeout_ms, or
        // cancel/replan). Delivery re-reads the wake snapshot, where the
        // escalated running node now appears (timeout_extensions > 0).
        yield* events.subscribe(DagEvent.NodeTimeoutEscalated).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              yield* tryDeliverWake(entry.parentSessionID).pipe(Effect.ignore, Effect.forkScoped)
            }).pipe(guarded("NodeTimeoutEscalated")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        // Workflow-control handlers cross-check the durable row under the
        // evalLock before mutating runtime flags: projection is transactional
        // with publish, so the row reflects this event or a later one — never
        // an earlier one. Applying the event's implied flags blindly lets a
        // cross-stream ordering (pause/resume/step race) clobber a newer
        // control decision. Mirrors the node handlers' DB arbitration.
        const refreshControlFlags = Effect.fnUntraced(function* (dagID: string, entry: WorkflowEntry) {
          const workflow = yield* store.getWorkflow(dagID)
          if (!workflow || isWorkflowTerminalStatus(workflow.status as never)) return undefined
          // F2: honor the veto hold — see WorkflowEntry.vetoHold.
          entry.runtime.setPaused(workflow.status === "paused" || entry.vetoHold)
          entry.runtime.setStepMode(workflow.status === "stepping")
          return workflow
        })

        yield* events.subscribe(DagEvent.WorkflowPaused).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              yield* entry.evalLock.withPermits(1)(refreshControlFlags(dagID, entry))
            }).pipe(guarded("WorkflowPaused")),
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
                  // F2 (DAG-03): resume/step is the parent's explicit control —
                  // release the fail-closed veto hold before the flag re-sync.
                  entry.vetoHold = false
                  const workflow = yield* refreshControlFlags(dagID, entry)
                  if (workflow?.status !== "stepping") return
                  // Dag.step validated "no in-flight node" on a DB snapshot
                  // taken outside this evalLock; a terminal-event handler can
                  // spawn in between (its DB status read predated the stepped
                  // projection). Spawning now would put a second node in
                  // flight under stepping — leave advancement to the next
                  // explicit step command instead.
                  if (entry.runtime.hasRunning()) return
                  yield* spawnReady(dagID)
                }),
              )
            }).pipe(guarded("WorkflowStepped")),
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
                  // F2 (DAG-03): resume/step is the parent's explicit control —
                  // release the fail-closed veto hold before the flag re-sync.
                  entry.vetoHold = false
                  const workflow = yield* refreshControlFlags(dagID, entry)
                  if (workflow?.status === "running") yield* spawnReady(dagID)
                  // A workflow can be resumed with every node already settled
                  // (e.g. recovery-pause on a single lost node). Without this,
                  // nothing else re-runs completion and the workflow hangs in
                  // running forever.
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(guarded("WorkflowResumed")),
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
                  // F2 (DAG-03): a replan is the parent's explicit disposition
                  // of the verdict — release the fail-closed veto hold and
                  // re-sync the control flags from the durable row (this
                  // handler never refreshed them, so a hold set by the verdict
                  // gate would otherwise silence the trailing spawnReady
                  // forever and the corrective nodes would never run).
                  entry.vetoHold = false
                  entry.runtime.setPaused(wf?.status === "paused")
                  entry.runtime.setStepMode(wf?.status === "stepping")
                  const oldConfig = entry.config
                  if (wf) entry.config = parseWorkflowConfig(wf.config)
                  // Rev-view (v1.0.15 Train A): THE aggregation filter point.
                  // The rebuild input is the CURRENT graph revision only —
                  // superseded rows (cancelled via replan, or terminal
                  // failures the fragment bypassed) must not re-seed as
                  // required-unsatisfied, or the wake-up bug fails a workflow
                  // on its replaced segment despite the new path succeeding.
                  // The re-time loop below only sees running rows (superseded
                  // rows are terminal), so the filter changes nothing there.
                  const nodes = yield* store.getCurrentNodes(dagID)
                  entry.runtime.rebuildGraph(toSchedulingNodes(nodes))
                  // Timeout extension (Q6): a running node gets a recomputed
                  // deadline (now + new timeout) ONLY when the replan carries a
                  // NEW worker_config.timeout_ms for it (§3.7) AND the node
                  // actually needs re-timing (deadline elapsed or escalation
                  // pending — see the gate below). Restarted nodes are pending
                  // here — their new attempt spawns a fresh watcher via
                  // spawnReady.
                  const newConfig = entry.config
                  for (const node of nodes) {
                    if (node.status !== "running") continue
                    const frag = newConfig?.nodes.find((candidate) => candidate.id === node.id)
                    if (!frag) continue
                    const oldTimeoutMs = oldConfig?.nodes.find((candidate) => candidate.id === node.id)?.worker_config?.timeout_ms
                    const fragTimeoutMs = frag.worker_config?.timeout_ms
                    // §3.7: re-time only when the replan carries a NEW
                    // timeout_ms. The persisted config behind WorkflowReplanned
                    // is the MERGED config — every non-cancel survivor keeps its
                    // definition — so a node the fragment never mentioned, or
                    // re-specified with an unchanged/omitted timeout_ms,
                    // matches here with its OLD timeout.
                    if (fragTimeoutMs == null || fragTimeoutMs === oldTimeoutMs) continue
                    const now = yield* Clock.currentTimeMillis
                    // Cap gate (A1) + delivery gate (Q2): both are SKIP
                    // conjuncts on the single re-time path (this handler is the
                    // only caller of nodeExtendTimeout; the watchdog never
                    // re-times — it only proposes escalations).
                    //   A1: a changed timeout alone must not move a healthy
                    //   deadline forward. An agent replanning BEFORE each
                    //   deadline with cycling values (10m→20m→10m…) would push
                    //   the deadline away forever without a single escalation
                    //   firing, so the extension count never climbs and the
                    //   ≈21× cap is bypassed. Re-time only when the current
                    //   deadline already elapsed or an escalation awaits
                    //   adjudication; a gated-off node keeps its deadline and
                    //   the self-renewing watcher escalates it the moment it
                    //   passes. A null deadline is treated as elapsed —
                    //   re-timing is what re-establishes supervision.
                    //   Q2: an escalated node whose wake has NOT been delivered
                    //   (escalationPending ∧ ¬wakeReported) is skipped too.
                    //   Adjudication must follow delivery — otherwise the
                    //   re-time below would call nodeExtendTimeout, which clears
                    //   escalation_pending and marks wake_reported, silently
                    //   adjudicating an escalation the main agent never saw
                    //   (D2). The node keeps its elapsed deadline and the
                    //   self-renewing watcher re-escalates toward the cap; the
                    //   wake is delivered normally. This is a SKIP conjunct, not
                    //   a pass-through disjunct — the disjunct form is swamped
                    //   by the deadlineElapsed case on the public path and is a
                    //   no-op there (cons-F1).
                    if (
                      (!node.escalationPending && node.deadlineMs != null && node.deadlineMs > now)
                      || (node.escalationPending && !node.wakeReported)
                    ) continue
                    // N1: write the new deadline FIRST. nodeExtendTimeout
                    // acquires the workflow lock and can fail or block; if the
                    // write never lands, the old watcher must keep supervising
                    // the old deadline — interrupting it beforehand would leave
                    // a RUNNING node with no watcher, no escalation, and a
                    // defeated cap backstop (§5-5).
                    // D1: one node's failed extend must not abort the rest of
                    // the handler — an uncaught failure propagates to
                    // guarded("WorkflowReplanned") and skips the stale-fiber
                    // sweep below plus spawnReady/checkCompletion, leaving
                    // restarted nodes pending with nobody to schedule them.
                    // A failed write also leaves the deadline unmoved, so the
                    // old watcher keeps supervising (N1) — this path must not
                    // touch it. Interruption still propagates: hasInterrupts is
                    // a structural check, whereas Cause.interruptors collects
                    // only DEFINED fiber IDs and ignores interrupt reasons
                    // carrying none — those would be swallowed as errors here.
                    const written = yield* dag.nodeExtendTimeout(dagID, node.id, now + fragTimeoutMs).pipe(
                      Effect.catchCause((cause) =>
                        Cause.hasInterrupts(cause)
                          ? Effect.failCause(cause)
                          : Effect.logWarning("DagLoop replan re-time failed; keeping the old watcher and continuing the batch", { dagID, nodeID: node.id, cause }).pipe(
                              Effect.as(-1),
                            ),
                      ),
                    )
                    // Negative verdict: -1 (write failure, mapped above) OR -2
                    // (Q2 delivery-gate rejection — the node is STILL RUNNING but
                    // its escalation wake was undelivered, raced in by the watchdog
                    // re-escalating under the workflow lock AFTER this handler's
                    // evalLock snapshot read at getNodes). In BOTH cases no deadline
                    // was written and the node remains running, so the old watcher
                    // must keep supervising the elapsed deadline and re-escalating
                    // toward the cap (N1: a running node is never left without a
                    // watcher). Clearing the watcher here would orphan the node and
                    // defeat the cap backstop.
                    if (written < 0) continue
                    if (written === 0) {
                      // 0 = TERMINAL rejection: the status='running' guard rejected
                      // the write — the node terminalized between the getNodes read
                      // and this command. Only THIS meaning reaches the branch now
                      // (C1 split the Q2 case into -2 above). No deadline was
                      // written; stop the old watcher and do not install one for a
                      // row the command refused to touch.
                      const deadWatcher = entry.watchers.get(node.id)
                      if (deadWatcher) yield* Fiber.interrupt(deadWatcher).pipe(Effect.ignore)
                      entry.watchers.delete(node.id)
                      yield* Effect.logWarning("DagLoop replan re-time skipped — node no longer running", { dagID, nodeID: node.id })
                      continue
                    }
                    // Write committed: install the re-armed watcher BEFORE
                    // interrupting the old one so supervision is never absent.
                    // F8's original race is benign in this order — the old
                    // watcher's next read sees the future deadline and sleeps;
                    // an escalation already in flight (lock-serialized behind
                    // this write) only adds a counted extension toward the cap,
                    // it never removes supervision. Its sole residue is re-setting
                    // escalation_pending on the now-extended node, which costs one
                    // redundant wake and permits one extra re-time via the gate
                    // above — cosmetic; the cap accounting still holds because the
                    // count did climb.
                    const newWatcher = yield* makeDeadlineWatcher({
                      dagID,
                      nodeID: node.id,
                      timeoutMs: fragTimeoutMs,
                      maxTimeoutExtensions: newConfig?.max_timeout_extensions ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions,
                    }).pipe(
                      Effect.provideService(Dag.Service, dag),
                      Effect.provideService(SessionPrompt.Service, promptSvc),
                      Effect.forkScoped,
                    )
                    const oldWatcher = entry.watchers.get(node.id)
                    entry.watchers.set(node.id, newWatcher)
                    if (oldWatcher) yield* Fiber.interrupt(oldWatcher).pipe(Effect.ignore)
                    yield* Effect.logInfo("DagLoop extended node deadline via replan", { dagID, nodeID: node.id, newDeadlineMs: now + fragTimeoutMs })
                  }
                  // Replan resets restarted nodes to pending. Old fibers of nodes
                  // that are no longer running/queued must be interrupted here:
                  // nothing else will (there is no NodeRestarted subscriber), and
                  // a leftover fiber's timeout path publishes NodeFailed — a legal
                  // pending→failed transition guardNode cannot reject — poisoning
                  // the new generation. Mirrors the workflow-terminal sweep.
                  for (const [nodeID, fiber] of [...entry.fibers]) {
                    const node = nodes.find((n) => n.id === nodeID)
                    if (node && (node.status === "running" || node.status === "queued")) continue
                    yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                    yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                    const watcher = entry.watchers.get(nodeID)
                    if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                    entry.fibers.delete(nodeID)
                    entry.watchers.delete(nodeID)
                  }
                  yield* spawnReady(dagID)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(guarded("WorkflowReplanned")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        for (const def of [DagEvent.WorkflowCompleted, DagEvent.WorkflowFailed, DagEvent.WorkflowCancelled]) {
          // Deliberately NO runtimes.has filter: a workflow terminalized by a
          // control op after a failed startup recovery (e.g. recoverWorkflow
          // aborted on an unreadable persisted row) has no runtime entry but
          // may still hold a dag registration from the startup wake sweep.
          // The handler stays a no-op for events not concerning this
          // instance: the evalLock cleanup and wake fork remain gated on
          // `entry`, and the no-entry release below is scoped by the durable
          // row's project — the same cross-instance guard every adoption
          // path uses.
          yield* events.subscribe(def).pipe(
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
                        const watcher = entry.watchers.get(nodeID)
                        if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                      }
                      entry.fibers.clear()
                      entry.watchers.clear()
                      runtimes.delete(dagID)
                    }),
                  )
                }
                // P1-6: trigger wake on workflow terminal so the parent
                // learns the final outcome even if no idle event fires.
                if (parentSessionID) {
                  // GOAL-FP-01-03: the dag registration lifetime is bound to
                  // workflow state, not to wake delivery. A workflow that
                  // terminalizes without a successful wake delivery must not
                  // keep its registration (and the Session's ownership)
                  // indefinitely. The key matches the registration key
                  // (WorkflowTable.id === event dagID, per the projector);
                  // tryDeliverWake re-registers its batch itself before
                  // claiming the wake lease when a delivery is attempted.
                  yield* automation.unregister(SessionID.make(parentSessionID), { kind: "dag", id: dagID })
                  yield* tryDeliverWake(parentSessionID).pipe(Effect.ignore, Effect.forkScoped)
                } else {
                  // GOAL-FP-01-03 follow-up (P2-A): no runtime entry, but the
                  // startup wake sweep may have registered this non-terminal
                  // row before its recovery failed. Release from the durable
                  // row (session_id + project) so a control-op
                  // terminalization cannot leave a permanent registration
                  // with no runtime to ever clean it. Foreign-project events
                  // are a no-op here.
                  const wf = yield* store.getWorkflow(dagID)
                  if (wf && wf.projectId === ctx.project.id) {
                    yield* automation.unregister(SessionID.make(wf.sessionId), { kind: "dag", id: dagID })
                  }
                }
              }).pipe(guarded("WorkflowTerminal")),
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
          // Timeout-escalated nodes must reach the main agent for
          // adjudication — their workflow is a delivery boundary even though
          // the runtime still reports a running node. F11: a non-eligible node
          // that escalated then terminalized (cap-exhausted force-cancel) must
          // deliver its verdict immediately, not wait for the next natural
          // boundary (it may never come while other nodes keep running).
          // The boundary is escalation_pending (a live, not-yet-adjudicated
          // escalation) OR an escalated node that terminalized — NOT the sticky
          // extension count alone, or an already-adjudicated running node would
          // override the delivery boundary for the rest of the attempt.
          const escalatedWorkflowIDs = new Set(
            snapshot.nodes
              .filter((node) => node.escalationPending || (node.timeoutExtensions > 0 && isNodeTerminalStatus(node.status as never)))
              .map((node) => node.workflowId),
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
            if (escalatedWorkflowIDs.has(workflow.id)) return true
            // Delivery boundary uses the runtime's own running set, NOT fiber
            // ownership: between markRunning and fibers.set the spawn path has
            // async yield points, and a wake reading that window would misjudge
            // "running, no fiber, nothing ready" as a stalled boundary and
            // deliver a mid-flight batch. The orchestrator-unresponsive net
            // below keeps the stricter fiber-ownership check.
            if (entry.runtime.hasRunning()) return false
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
          // Cross-instance guard via the execution-location authority: wake
          // delivery is store-global (idle Status events, node-terminal
          // handlers, the startup sweep). Only the instance whose DIRECTORY
          // owns the session's workflows may deliver its wakes — sibling
          // worktrees of the same project must ignore each other's idle
          // sessions. The guard also covers the workflow-terminal stimulus
          // after a session deletion (the durable rows are gone).
          if (!(yield* DagLocation.ownsSession(sessionID, ctx.directory))) return
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
                    // Torn-read fix: every runtime/fibers mutation happens as a
                    // pair inside this entry's evalLock (markRunning+fibers.set
                    // in spawnReady, settle+spawnReady in the terminal handlers),
                    // so reading the five conditions under the same lock waits
                    // out the markRunning→fibers.set window instead of misreading
                    // it as a stalled orchestrator. dag.fail must run under the
                    // SAME permit: releasing the lock between the check and the
                    // fail lets a terminal-event handler spawn new ready nodes in
                    // the window, and the stale verdict would then kill a
                    // progressing workflow. evalLock→workflowLock nesting is the
                    // established order here (checkCompletion inside evalLock
                    // takes the same KeyedMutex); dag.ts never acquires evalLock,
                    // so no reverse ordering exists.
                    yield* entry.evalLock.withPermits(1)(
                      Effect.gen(function* () {
                        const shouldFail =
                          !entry.runtime.isPaused()
                          && !entry.runtime.isStepMode()
                          // Suppress the net only when current-process execution
                          // ownership proves that a running node is making progress.
                          && !entry.runtime.hasRunningMatching((id) => entry.fibers.has(id))
                          && entry.runtime.getReadyNodes().length === 0
                          && !entry.runtime.isComplete()
                        if (shouldFail) yield* dag.fail(dagID, "orchestrator_unresponsive").pipe(Effect.ignore)
                      }),
                    )
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

              const failuresByWorkflow = new Map<string, string[]>()
              for (const workflow of batch.workflows) {
                if (workflow.status !== "failed") continue
                // Rev-view (v1.0.15 Train A): attribution is terminal
                // aggregation — only CURRENT-revision failures are attributed.
                // Superseded replaced failures (cancelled rows already fall
                // out via errorClass null) must not be re-attributed.
                const failedNodes = yield* store.getCurrentNodes(workflow.id).pipe(
                  Effect.map((nodes) => nodes.filter((node): node is DagStore.NodeRow & { errorClass: string } => node.status === "failed" && node.errorClass !== null)),
                  Effect.catchCause((cause) =>
                    Effect.gen(function* () {
                      yield* Effect.logWarning("wake digest failed to read failed nodes", { workflowId: workflow.id, cause })
                      return [] as (DagStore.NodeRow & { errorClass: string })[]
                    }),
                  ),
                )
                if (failedNodes.length > 0) {
                  failuresByWorkflow.set(
                    workflow.id,
                    failedNodes.map((node) => `- "${node.name}" (${node.errorClass}): ${node.errorReason ?? "unknown error"}`.slice(0, 300)),
                  )
                }
              }
              const summaries = [
                ...batch.nodes.map((node) => {
                  // The timeout advisory is for a running node awaiting
                  // adjudication (escalation_pending). A batch node is
                  // wake_reported=false, so it cannot be an already-adjudicated
                  // extend — escalation_pending and timeoutExtensions>0 agree
                  // here; the flag is the intent-level signal.
                  if (node.status === "running" && node.escalationPending) {
                    return `[DAG Node Timeout] RUNNING node "${node.name}" exceeded its execution deadline (timeout escalation ${node.timeoutExtensions}) and is still executing. Adjudicate by replanning with a NEW worker_config.timeout_ms to extend the node — that grants more execution time, but the cumulative extension count is NOT reset (only a new attempt resets it), and the node is force-cancelled once the cap is reached — or cancel/replan the node. Queued nodes are not extended: their admission deadline was fixed at permit acquisition and is not adjusted by extensions.`
                  }
                  const durableResult =
                    typeof node.output === "string"
                      ? node.output
                      : (node.errorReason ?? (node.output == null ? "(no output)" : JSON.stringify(node.output)))
                  const truncated = durableResult.length > 500
                  const output = durableResult.slice(0, 500)
                  const failureClass = node.status === "failed" && node.errorClass ? ` (${node.errorClass})` : ""
                  const retrieval = truncated
                    ? `\nComplete output: call workflow result with workflow_id="${node.workflowId}" and node_id="${node.id}".`
                    : ""
                  return `[DAG Node Result] Node "${node.name}" ${node.status}${failureClass}: ${output}\n[DAG Result Reference] workflow_id="${node.workflowId}" node_id="${node.id}" truncated=${truncated}${retrieval}`
                }),
                ...batch.workflows.map((workflow) => {
                  const failures = failuresByWorkflow.get(workflow.id)
                  const attribution = failures ? `\nFailed nodes:\n${failures.join("\n")}` : ""
                  return `[DAG Workflow ${workflow.status}] Workflow "${workflow.title}" has reached terminal status.${attribution}`
                }),
              ]
              const summary = [
                ...summaries,
                ...(plan.actionableDagIDs.size > 0
                  ? ['You MUST act on these workflows in this turn (workflow tool: extend / control replan / complete / cancel). If this turn ends with a workflow stalled and no action taken, it will be failed with reason "orchestrator_unresponsive".']
                  : []),
              ].join("\n\n")

              const wakeWorkflowIDs = new Set([
                ...batch.nodes.map((node) => node.workflowId),
                ...batch.workflows.map((workflow) => workflow.id),
              ])
              for (const workflowID of wakeWorkflowIDs) {
                yield* automation.register(SessionID.make(sessionID), { kind: "dag", id: workflowID })
              }
              const wakeLease = Option.getOrUndefined(
                yield* automation.claim(SessionID.make(sessionID), { kind: "dag" }),
              )
              if (!wakeLease) return

              // The part is marked synthetic: model-visible (the orchestrator
              // receives the node result and can act) but NOT rendered as a user
              // message in the TUI chat — DAG data surfaces via the sidebar panel
              // and Inspector, keeping the chat conversation clean.
              //
              // ADMIT SUCCESS == DELIVERED (issue #321). The previous contract
              // (GOAL-FP-01-14) persisted wake_reported only AFTER the whole
              // wake-driven parent turn completed. A restart or mid-turn
              // interruption therefore left wake_reported=false while the
              // synthetic part was already durable in transcript, so the startup
              // sweep re-injected a byte-identical wake (real incident: the same
              // 4391-char wake injected twice, ~10 min apart, after a TUI
              // restart). Redelivery adds duplicates, never information. The
              // mark (and the terminal-workflow unregisters) now land right
              // after admitIfIdle admits the part, BEFORE awaiting the turn.
              //
              // The in-memory dedup map still guards the retry path: if the
              // leased mark below returns None (generation/owner changed), the
              // rows stay unreported and a later trigger re-marks without
              // re-prompting. A differing summary (new results committed between
              // attempts) always prompts.
              if (deliveredWakeSummaries.size > 1024) deliveredWakeSummaries.clear()
              const didDeliver = yield* Effect.gen(function* () {
                let wakeTurn: Effect.Effect<SessionV1.WithParts> | undefined
                if (deliveredWakeSummaries.get(sessionID) !== summary) {
                  const delivered = yield* SessionPrompt.admitIfIdle(promptSvc, automation, wakeLease, {
                    sessionID: SessionID.make(sessionID),
                    parts: [{ type: "text", text: summary, synthetic: true }],
                  })
                  if (Option.isNone(delivered)) return false
                  deliveredWakeSummaries.set(sessionID, summary)
                  wakeTurn = delivered.value
                }

                // Admit success == delivered (issue #321): persist wake_reported
                // at admit time. A leased mark returning None (generation/owner
                // raced) is treated as retry-later — the rows stay unreported and
                // a later trigger re-marks — but the admitted turn still runs
                // below (its end-of-turn idle is what re-arms that retry).
                const markLease = Option.getOrUndefined(
                  yield* automation.claim(SessionID.make(sessionID), { kind: "dag" }),
                )
                // Any mark failure (lease lost, generation raced, or the store
                // write dying) degrades to retry-later instead of propagating:
                // the rows stay unreported and a later trigger re-marks, while
                // the admitted turn below still runs (its end-of-turn idle is
                // what re-arms that retry). Only interruption propagates.
                const markSucceeded = markLease
                  ? Option.isSome(
                      yield* automation.use(markLease, store.markWakeBatchReported(batch)).pipe(
                        Effect.catchCause((cause) =>
                          Cause.hasInterrupts(cause)
                            ? Effect.failCause(cause)
                            : Effect.logWarning("DAG wake batch mark failed; rows stay unreported for retry", {
                                sessionID,
                                cause: Cause.pretty(cause),
                              }).pipe(Effect.as(Option.none())),
                        ),
                      ),
                    )
                  : false
                if (markSucceeded) {
                  plan.unresponsiveDagIDs.forEach((workflowID) => deliveredUnresponsiveDagIDs.add(workflowID))
                  yield* Effect.forEach(
                    batch.workflows.filter((workflow) => isWorkflowTerminalStatus(workflow.status as never)),
                    (workflow) => automation.unregister(SessionID.make(sessionID), { kind: "dag", id: workflow.id }),
                    { discard: true },
                  )
                }

                // Pacing — keep one wake turn at a time. The turn runs AFTER the
                // durable mark, so its failure can no longer lose the report;
                // swallow non-interrupt failures instead of surfacing them as a
                // delivery failure. It also runs when the mark raced, so its
                // end-of-turn idle re-arms the mark retry.
                if (wakeTurn) {
                  yield* wakeTurn.pipe(
                    Effect.catchCause((cause) =>
                      Cause.hasInterrupts(cause)
                        ? Effect.failCause(cause)
                        : Effect.logInfo("DAG wake turn did not complete; wake already reported", {
                            sessionID,
                            cause: Cause.pretty(cause),
                          }),
                    ),
                  )
                }
                return markSucceeded
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("DAG wake delivery failed", { sessionID, cause: Cause.pretty(cause) }).pipe(
                    Effect.as(false),
                  ),
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

        // Idle-event subscription: the primary wake trigger. The handler only
        // forks, so the subscription itself cannot die — guarded here so a
        // defect inside a delivery attempt is logged instead of silently
        // killing its fiber.
        yield* events.subscribe(SessionStatusEvent.Status).pipe(
          Stream.filter((evt) => evt.data.status.type === "idle"),
          Stream.runForEach((evt) =>
            tryDeliverWake(evt.data.sessionID as string).pipe(guarded("WakeDelivery"), Effect.forkScoped),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        // R5 session-deletion teardown: when the parent session is removed,
        // Session.remove publishes SessionV1.Event.Deleted and the FK cascade
        // wipes the workflow + node rows. The in-memory runtime entry must go
        // with them — otherwise a later stimulus (e.g. a workflow-terminal
        // event on the deleted dagID) would still find the entry in
        // `runtimes` and interrupt live fibers / drive a workflow that no
        // longer exists durably. Mirror the workflow-terminal cleanup
        // pattern: evalLock-serialized fiber + watcher interrupts, then drop
        // the entry.
        yield* events.subscribe(SessionV1.Event.Deleted).pipe(
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const sessionID = evt.data.sessionID as string
              // Map iteration is mutation-safe for deletions of visited
              // entries — only THIS entry is deleted, inside its own evalLock.
              for (const [dagID, entry] of runtimes) {
                if (entry.parentSessionID !== sessionID) continue
                yield* entry.evalLock.withPermits(1)(
                  Effect.gen(function* () {
                    for (const [nodeID, fiber] of entry.fibers) {
                      const node = yield* store.getNode(dagID, nodeID)
                      yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                      yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                      const watcher = entry.watchers.get(nodeID)
                      if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                    }
                    entry.fibers.clear()
                    entry.watchers.clear()
                    runtimes.delete(dagID)
                  }),
                )
              }
            }).pipe(guarded("SessionDeleted")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        // #269 SessionMoved ownership convergence: the Moved projection
        // (core session projector) re-stamps the session's workflow rows to the
        // destination directory in the SAME durable transaction, so by the time
        // this handler runs the durable rows already agree on ONE directory.
        // Converge the in-memory side: (a) the instance that no LONGER owns the
        // moved session's workflows evicts its stale runtime entries (fail-closed
        // — its directory must not keep acting on them), and (b) the NEW owner
        // re-forks the serialized wake drain so a terminal wake that was wedged
        // behind the old mixed stamps delivers immediately (bounded time) instead
        // of waiting for a fresh idle event or a restart.
        yield* events.subscribe(SessionEvent.Moved).pipe(
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const sessionID = evt.data.sessionID as string
              // Map iteration is mutation-safe for deletions of visited entries —
              // only entries of THIS session are deleted, each inside its own
              // evalLock. Evict only entries the re-stamp moved AWAY from this
              // instance (ownsWorkflow re-reads the durable row).
              for (const [dagID, entry] of runtimes) {
                if (entry.parentSessionID !== sessionID) continue
                if (yield* DagLocation.ownsWorkflow(dagID, ctx.directory)) continue
                yield* entry.evalLock.withPermits(1)(
                  Effect.gen(function* () {
                    for (const [nodeID, fiber] of entry.fibers) {
                      const node = yield* store.getNode(dagID, nodeID)
                      yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                      yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                      const watcher = entry.watchers.get(nodeID)
                      if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                    }
                    entry.fibers.clear()
                    entry.watchers.clear()
                    runtimes.delete(dagID)
                  }),
                )
              }
              // New owner: the re-stamp moved ownership HERE, so wake rows that
              // were wedged (mixed stamps → no owner) are now deliverable.
              if (yield* DagLocation.ownsSession(sessionID, ctx.directory)) {
                yield* tryDeliverWake(sessionID).pipe(Effect.ignore, Effect.forkScoped)
              }
            }).pipe(guarded("SessionMoved")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        // Install all live event handlers before spawning recovery watchers so
        // a child that settles immediately cannot leave the runtime stale.
        // Orphan-pending sweep first: the WorkflowStarted it publishes for the
        // terminalization leg is rejected by the handler's status guard above
        // (the row is already failed once the event arrives), never adopted.
        const pendingWfs = yield* store.listByStatus("pending").pipe(Effect.orDie)
        for (const wf of pendingWfs) {
          yield* recoverOrphanPending(wf).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DagLoop orphan pending recovery failed for workflow", { dagID: wf.id, cause }),
            ),
          )
        }
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
        // Store failures here are defects (the store's error channel is never);
        // absorb them with a warning so layer construction survives, but never
        // silently — a swallowed failure means wake redelivery is lost until
        // the next process restart.
        const pendingWakeSessions = yield* store.getSessionsWithUnreportedWakes().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("DagLoop failed to list sessions with unreported wakes", { cause }).pipe(
              Effect.as([] as string[]),
            ),
          ),
        )
        for (const sessionID of pendingWakeSessions) {
          // Cross-instance guard via the execution-location authority: wake
          // redelivery is store-global. Only drain sessions whose workflows
          // belong to this instance's DIRECTORY — sibling worktrees of the
          // same project share the project id and must not deliver each
          // other's wakes.
          if (!(yield* DagLocation.ownsSession(sessionID, ctx.directory))) continue
          // The wake snapshot's own workflow rows carry a second ownership
          // proof — only drain sessions whose unreported workflows belong to
          // this project.
          const snapshot = yield* store.getWakeSnapshot(sessionID).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DagLoop failed to read wake snapshot", { sessionID, cause }).pipe(
                Effect.as({ nodes: [], workflows: [] } satisfies DagStore.WakeSnapshot),
              ),
            ),
          )
          if (!snapshot.workflows.some((wf) => wf.projectId === ctx.project.id)) continue
          // GOAL-FP-01-01: register only NON-terminal workflows. Terminal
          // workflows with wake_reported=true would otherwise be re-registered
          // on every restart and never unregistered (the only unregister for
          // them lives in the wake-delivery SUCCESS path, whose batch only
          // carries unreported workflows) — permanently leaking a dag
          // registration and blocking the goal. Terminal-but-unreported
          // workflows are safe to skip here too: tryDeliverWake registers
          // every workflow in its batch itself right before claiming the wake
          // lease, so wake redelivery does not depend on this sweep.
          yield* Effect.forEach(
            snapshot.workflows.filter((workflow) => !isWorkflowTerminalStatus(workflow.status as never)),
            (workflow) =>
              automation.register(SessionID.make(sessionID), { kind: "dag", id: workflow.id }),
            { discard: true },
          )
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

export const layer = serviceLayer.pipe(Layer.provide(SessionAutomationLease.defaultLayer))

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
