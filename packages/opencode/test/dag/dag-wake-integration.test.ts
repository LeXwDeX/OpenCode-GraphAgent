import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { TerminalViolationError } from "@opencode-ai/core/dag/core/types"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { WorkflowNodeTable, WorkflowTable } from "@opencode-ai/core/dag/sql"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout, testEffect } from "../lib/effect"

const integration = testEffect(Layer.empty)

interface PromptGate {
  readonly title: string
  readonly input: SessionPrompt.PromptInput
  readonly release: Deferred.Deferred<string>
}

interface ParentPromptGate {
  readonly input: SessionPrompt.PromptInput
  readonly release: Deferred.Deferred<"success" | "failure">
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption("1 second"),
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new Error(message)),
      onSome: Effect.succeed,
    })),
  )
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: sessionID as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: text ? [{ type: "text", text }] as never : [],
  }
}

function node(id: string, dependsOn: string[] = []): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    report_to_parent: true,
  }
}

function promptText(input: SessionPrompt.PromptInput) {
  return input.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function wakeLayer(input: {
  readonly childPrompts: Queue.Queue<PromptGate>
  readonly parentPrompts: Queue.Queue<ParentPromptGate>
  readonly parentSettled: Queue.Queue<void>
}) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
  )
  const dag = Dag.layer.pipe(
    Layer.provide(bridge),
    Layer.provide(store),
  )
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  const childTitles = new Map<string, string>()
  const created: string[] = []
  const session = Layer.mock(Session.Service, {
    get: () => Effect.succeed({ id: "ses_parent", permission: [], agent: "build" } as never),
    create: (value) =>
      Effect.sync(() => {
        const id = `ses_child_${created.length + 1}`
        created.push(id)
        childTitles.set(id, (value?.title ?? id).replace(" (DAG node)", ""))
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    if (sessionID === "ses_parent") {
      const release = yield* Deferred.make<"success" | "failure">()
      yield* Queue.offer(input.parentPrompts, { input: value, release })
      const outcome = yield* Deferred.await(release).pipe(
        Effect.ensuring(Queue.offer(input.parentSettled, undefined)),
      )
      if (outcome === "failure") return yield* Effect.die(new Error("provider unavailable"))
      return reply(sessionID, "parent handled wake")
    }
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(input.childPrompts, {
      title: childTitles.get(sessionID) ?? sessionID,
      input: value,
      release,
    })
    return reply(sessionID, yield* Deferred.await(release))
  })
  const prompt = Layer.mock(SessionPrompt.Service, {
    cancel: () => Effect.void,
    prompt: deliver,
    promptIfIdle: (value) => deliver(value).pipe(Effect.map(Option.some)),
  })
  const agent = Layer.mock(Agent.Service, {
    get: () => Effect.succeed({
      name: "build",
      mode: "all",
      permission: [],
      options: {},
      description: "",
      prompt: "",
      model: { providerID: "test" as never, modelID: "test-model" as never },
      tools: {},
      hooks: {},
    }),
  })
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
  )
  return Layer.merge(base, loop)
}

function runWakeTest<A>(
  test: (services: {
    readonly dag: Dag.Interface
    readonly loop: DagLoop.Interface
    readonly store: DagStore.Interface
    readonly status: SessionStatus.Interface
    readonly childPrompts: Queue.Queue<PromptGate>
    readonly parentPrompts: Queue.Queue<ParentPromptGate>
    readonly parentSettled: Queue.Queue<void>
  }) => Effect.Effect<A, Error>,
  beforeInit?: (services: {
    readonly database: Database.Interface
  }) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    const parentPrompts = yield* Queue.unbounded<ParentPromptGate>()
    const parentSettled = yield* Queue.unbounded<void>()
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const status = yield* SessionStatus.Service
      const database = yield* Database.Service
      yield* database.db.insert(ProjectTable).values({
        id: "project-1" as never,
        worktree: process.cwd() as never,
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({
        id: "ses_parent" as never,
        project_id: "project-1" as never,
        slug: "parent",
        directory: process.cwd() as never,
        title: "Parent",
        version: "test",
      }).run().pipe(Effect.orDie)
      if (beforeInit) yield* beforeInit({ database })
      yield* loop.init()
      return yield* test({ dag, loop, store, status, childPrompts, parentPrompts, parentSettled })
    }).pipe(
      Effect.provide(wakeLayer({ childPrompts, parentPrompts, parentSettled })),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: "project-1" },
      } as never),
      Effect.scoped,
    )
  })
}

describe("DagLoop atomic wake integration", () => {
  it("preserves documented template variables inside static template input", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Static template documentation",
            config: {
              name: "static-template-documentation",
              nodes: [
                {
                  ...node("review-guidance"),
                  prompt_template: {
                    inline: "Review this guidance:\n{{guidance}}",
                    input: {
                      guidance: "Workflow examples use {{node-id}} as a documented template variable.",
                    },
                  },
                },
              ],
            },
          })

          const review = yield* takeWithin(childPrompts, "review-guidance did not start")
          expect(promptText(review.input)).toContain(
            "Workflow examples use {{node-id}} as a documented template variable.",
          )
          yield* Deferred.succeed(review.release, "The guidance is clear.")
        }),
      ),
    )
  })

  it("preserves documented template variables inside dependency output", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Documented template variable",
            config: {
              name: "documented-template-variable",
              nodes: [
                node("analyze-security"),
                {
                  ...node("review-security", ["analyze-security"]),
                  prompt_template: { inline: "Review this analysis:\n{{analyze-security}}" },
                },
              ],
            },
          })

          const analyze = yield* takeWithin(childPrompts, "analyze-security did not start")
          yield* Deferred.succeed(
            analyze.release,
            "Workflow examples use {{node-id}} as a documented template variable.",
          )

          const review = yield* takeWithin(childPrompts, "review-security did not start")
          expect(review.title).toBe("review-security")
          expect(promptText(review.input)).toContain(
            "Workflow examples use {{node-id}} as a documented template variable.",
          )
          yield* Deferred.succeed(review.release, "No security issues found.")

          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? workflow : undefined),
            ),
            "workflow did not complete",
          )
        }),
      ),
    )
  })

  it("runs a required fan-in after an optional dependency fails", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Optional review failure",
            config: {
              name: "optional-review-failure",
              nodes: [
                node("analysis"),
                {
                  ...node("review-quality", ["analysis"]),
                  required: false,
                },
                {
                  ...node("review-security", ["analysis"]),
                  required: false,
                  condition: "analysis.output.verdict ==",
                },
                {
                  ...node("arbitrate", ["review-quality", "review-security"]),
                  prompt_template: {
                    inline: "Quality review: {{review-quality}}\nSecurity review: {{review-security}}",
                  },
                },
              ],
            },
          })

          const analysis = yield* takeWithin(childPrompts, "analysis did not start")
          yield* Deferred.succeed(analysis.release, "The implementation follows the approved design.")

          const quality = yield* takeWithin(childPrompts, "review-quality did not start")
          expect(quality.title).toBe("review-quality")
          yield* Deferred.succeed(quality.release, "No quality issues found.")

          const arbitrate = yield* takeWithin(childPrompts, "arbitrate did not start")
          const text = promptText(arbitrate.input)
          expect(text).toContain("No quality issues found.")
          expect(text).toContain('Dependency "review-security" failed:')
          yield* Deferred.succeed(arbitrate.release, "Proceed with one review unavailable.")

          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? workflow : undefined),
            ),
            "workflow did not complete",
          )
          expect((yield* store.getNode(dagID, "review-security"))?.status).toBe("failed")
        }),
      ),
    )
  })

  it("injects direct dependency outputs into an aggregate node by default", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Default aggregate inputs",
            config: {
              name: "default-aggregate-inputs",
              nodes: [
                node("node-a"),
                node("node-b"),
                {
                  ...node("summary", ["node-a", "node-b"]),
                  prompt_template: { inline: "汇总结果：{{node-a}} 和 {{node-b}}" },
                },
              ],
            },
          })

          const first = yield* takeWithin(childPrompts, "first parallel node did not start")
          const second = yield* takeWithin(childPrompts, "second parallel node did not start")
          const roots = new Map([first, second].map((item) => [item.title, item]))
          yield* Deferred.succeed(roots.get("node-a")!.release, "A")
          yield* Deferred.succeed(roots.get("node-b")!.release, "B")

          const summary = yield* takeWithin(childPrompts, "summary node did not start")
          expect(summary.title).toBe("summary")
          expect(promptText(summary.input)).toContain("汇总结果：A 和 B")
          expect(promptText(summary.input)).not.toContain("{{node-a}}")
          expect(promptText(summary.input)).not.toContain("{{node-b}}")
          yield* Deferred.succeed(summary.release, "A and B")
        }),
      ),
    )
  })

  integration.live("runs an additive wave after a terminal checkpoint wake", () =>
    runWakeTest(({ dag, store, childPrompts, parentPrompts }) =>
      Effect.gen(function* () {
        const dagID = yield* dag.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "Additive checkpoint continuation",
          config: {
            name: "additive-checkpoint-continuation",
            nodes: [node("checkpoint")],
          },
        })

        const checkpoint = yield* takeWithin(childPrompts, "checkpoint did not start")
        yield* Deferred.succeed(checkpoint.release, "REVISE")
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(
            Effect.map((workflow) => workflow?.status === "completed" ? true : undefined),
          ),
          "checkpoint workflow did not complete",
        )

        const parent = yield* takeWithin(parentPrompts, "terminal checkpoint did not wake the parent")
        const result = yield* dag.extend(dagID, [node("repair", ["checkpoint"])])
        expect(result.add).toEqual(["repair"])

        const repair = yield* takeWithin(childPrompts, "additive repair node did not start")
        expect(repair.title).toBe("repair")
        expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
        expect((yield* store.getNode(dagID, "checkpoint"))?.status).toBe("completed")
        yield* Deferred.succeed(parent.release, "success")
        yield* Deferred.succeed(repair.release, "fixed")
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(
            Effect.map((workflow) => workflow?.status === "completed" ? true : undefined),
          ),
          "extended workflow did not complete",
        )
      }),
    ),
  )

  integration.live("keeps an early-completed workflow terminal", () =>
    runWakeTest(({ dag, store, childPrompts }) =>
      Effect.gen(function* () {
        const dagID = yield* dag.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "Early completion",
          config: {
            name: "early-completion",
            nodes: [node("checkpoint"), node("later", ["checkpoint"])],
          },
        })

        yield* takeWithin(childPrompts, "checkpoint did not start")
        yield* dag.complete(dagID)
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(
            Effect.map((workflow) => workflow?.status === "completed" ? true : undefined),
          ),
          "workflow did not early-complete",
        )
        expect((yield* store.getNode(dagID, "later"))?.errorReason).toBe("agent_complete")

        const error = yield* dag.extend(dagID, [node("repair", ["checkpoint"])]).pipe(
          Effect.catch((cause: Error) => Effect.succeed(cause)),
        )
        expect(error).toBeInstanceOf(TerminalViolationError)
      }),
    ),
  )

  integration.live("keeps a completed non-reporting leaf workflow terminal", () =>
    runWakeTest(({ dag, store, childPrompts }) =>
      Effect.gen(function* () {
        const dagID = yield* dag.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "Non-reporting completion",
          config: {
            name: "non-reporting-completion",
            nodes: [{ ...node("leaf"), report_to_parent: false }],
          },
        })

        const leaf = yield* takeWithin(childPrompts, "leaf did not start")
        yield* Deferred.succeed(leaf.release, "done")
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(
            Effect.map((workflow) => workflow?.status === "completed" ? true : undefined),
          ),
          "non-reporting workflow did not complete",
        )
        expect((yield* store.getNode(dagID, "leaf"))?.wakeEligible).toBe(false)

        const error = yield* dag.extend(dagID, [node("extra", ["leaf"])]).pipe(
          Effect.catch((cause: Error) => Effect.succeed(cause)),
        )
        expect(error).toBeInstanceOf(TerminalViolationError)
      }),
    ),
  )

  it("fails an aggregate node before execution when template placeholders remain unresolved", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Unresolved aggregate input",
            config: {
              name: "unresolved-aggregate-input",
              nodes: [
                node("node-a"),
                {
                  ...node("summary", ["node-a"]),
                  input_mapping: {},
                  prompt_template: { inline: "汇总结果：{{node-a}}" },
                },
              ],
            },
          })

          const root = yield* takeWithin(childPrompts, "root node did not start")
          yield* Deferred.succeed(root.release, "A")

          yield* pollWithTimeout(
            store.getNode(dagID, "summary").pipe(
              Effect.map((item) => item?.status === "failed" ? item : undefined),
            ),
            "summary node did not fail",
          )
          const summary = yield* store.getNode(dagID, "summary")
          expect(summary?.errorReason).toContain("Unresolved template placeholders")
          expect(yield* Queue.poll(childPrompts)).toEqual(Option.none())
        }),
      ),
    )
  })

  it("does not block a second workflow's downstream scheduling on a parent wake", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Wake source",
            config: { name: "wake-source", nodes: [node("wake-source")] },
          })
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Independent pipeline",
            config: { name: "pipeline", nodes: [node("root"), node("downstream", ["root"])] },
          })

          const first = yield* takeWithin(childPrompts, "first root node did not start")
          const second = yield* takeWithin(childPrompts, `second root node did not start after ${first.title}`)
          const prompts = new Map([first, second].map((item) => [item.title, item]))
          yield* Deferred.succeed(prompts.get("wake-source")!.release, "wake result")

          const parent = yield* takeWithin(parentPrompts, "terminal workflow did not trigger a parent wake")
          yield* Deferred.succeed(prompts.get("root")!.release, "root result")

          const downstream = yield* takeWithin(
            childPrompts,
            "downstream scheduling waited for the blocked parent wake",
          )
          expect(downstream.title).toBe("downstream")

          yield* Deferred.succeed(parent.release, "success")
          yield* Deferred.succeed(downstream.release, "done")
        }),
      ),
    )
  })

  it("batches parallel results and the terminal workflow into one deterministic prompt", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Parallel batch",
            config: {
              name: "parallel-batch",
              nodes: [node("a"), node("b"), node("aggregate", ["a", "b"])],
            },
          })

          const first = yield* takeWithin(childPrompts, "first parallel node did not start")
          const second = yield* takeWithin(childPrompts, "second parallel node did not start")
          const parallel = new Map([first, second].map((item) => [item.title, item]))
          yield* Deferred.succeed(parallel.get("a")!.release, "A")
          yield* Deferred.succeed(parallel.get("b")!.release, "B")

          const aggregate = yield* takeWithin(
            childPrompts,
            "aggregate scheduling waited for an intermediate parent wake",
          )
          expect(aggregate.title).toBe("aggregate")
          expect(Option.isNone(yield* Queue.poll(parentPrompts))).toBe(true)
          yield* Deferred.succeed(aggregate.release, "AB")

          const parent = yield* takeWithin(parentPrompts, "terminal batch did not wake the parent")
          const text = promptText(parent.input)
          expect(text).toContain('Node "a" completed: A')
          expect(text).toContain('Node "b" completed: B')
          expect(text).toContain('Node "aggregate" completed: AB')
          expect(text).toContain('Workflow "Parallel batch" has reached terminal status')
          expect(text).not.toContain("You MUST act")
          expect(text.indexOf('Node "a"')).toBeLessThan(text.indexOf('Node "b"'))
          expect(text.indexOf('Node "b"')).toBeLessThan(text.indexOf('Node "aggregate"'))
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  it("keeps rows committed during delivery for a later stable batch", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "First workflow",
            config: { name: "first", nodes: [node("first-node")] },
          })
          const firstNode = yield* takeWithin(childPrompts, "first workflow did not start")
          yield* Deferred.succeed(firstNode.release, "first")
          const firstParent = yield* takeWithin(parentPrompts, "first workflow did not wake the parent")

          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Late workflow",
            config: { name: "late", nodes: [node("late-node")] },
          })
          const lateNode = yield* takeWithin(childPrompts, "late workflow did not start")
          yield* Deferred.succeed(lateNode.release, "late")
          expect(promptText(firstParent.input)).not.toContain("late-node")

          yield* Deferred.succeed(firstParent.release, "success")
          const secondParent = yield* takeWithin(parentPrompts, "late result was not delivered in a later batch")
          expect(promptText(secondParent.input)).toContain('Node "late-node" completed: late')
          yield* Deferred.succeed(secondParent.release, "success")
        }),
      ),
    )
  })

  it("leaves the whole batch unreported when parent delivery fails", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, childPrompts, parentPrompts, parentSettled }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Retryable workflow",
            config: { name: "retryable", nodes: [node("retryable-node")] },
          })
          const child = yield* takeWithin(childPrompts, "retryable node did not start")
          yield* Deferred.succeed(child.release, "retry me")
          const parent = yield* takeWithin(parentPrompts, "retryable batch did not wake the parent")
          yield* Deferred.succeed(parent.release, "failure")
          yield* takeWithin(parentSettled, "failed parent prompt did not settle")

          expect(yield* store.getUnreportedWakeNodes("ses_parent")).toHaveLength(1)
          expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toHaveLength(1)
        }),
      ),
    )
  })

  it("redelivers an unreported durable batch during startup", async () => {
    await Effect.runPromise(
      runWakeTest(
        ({ parentPrompts }) =>
          Effect.gen(function* () {
            const parent = yield* takeWithin(parentPrompts, "startup scan did not redeliver the durable batch")
            const text = promptText(parent.input)
            expect(text).toContain('Node "recovered-node" completed: recovered')
            expect(text).toContain('Workflow "Recovered workflow" has reached terminal status')
            yield* Deferred.succeed(parent.release, "success")
          }),
        ({ database }) =>
          database.db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(WorkflowTable).values({
                id: "recovered-workflow",
                project_id: "project-1" as never,
                session_id: "ses_parent" as never,
                title: "Recovered workflow",
                status: "completed",
                config: "{}",
                seq: 10,
                wake_reported: false,
              }).run()
              yield* tx.insert(WorkflowNodeTable).values({
                id: "recovered-node",
                workflow_id: "recovered-workflow",
                name: "recovered-node",
                worker_type: "build",
                status: "completed",
                required: true,
                depends_on: [],
                output: "recovered",
                wake_eligible: true,
                wake_reported: false,
                seq: 9,
              }).run()
            }),
          ).pipe(Effect.orDie),
      ),
    )
  })

  it("keeps a wake unreported while the parent is busy and delivers it on idle", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, status, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          yield* status.set("ses_parent" as never, { type: "busy" })
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Busy parent",
            config: { name: "busy-parent", nodes: [node("busy-node")] },
          })
          const child = yield* takeWithin(childPrompts, "busy-parent node did not start")
          yield* Deferred.succeed(child.release, "held result")
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? true as const : undefined),
            ),
            "workflow did not complete while its parent was busy",
          )

          expect(Option.isNone(yield* Queue.poll(parentPrompts))).toBe(true)
          expect(yield* store.getUnreportedWakeNodes("ses_parent")).toHaveLength(1)
          expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toHaveLength(1)

          yield* status.set("ses_parent" as never, { type: "idle" })
          const parent = yield* takeWithin(parentPrompts, "idle transition did not deliver the retained batch")
          expect(promptText(parent.input)).toContain('Node "busy-node" completed: held result')
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  it("wakes at paused and stepping decision boundaries", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, childPrompts, parentPrompts, parentSettled }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Controlled workflow",
            config: {
              name: "controlled",
              nodes: [node("root"), node("next", ["root"]), node("after", ["next"])],
            },
          })
          const root = yield* takeWithin(childPrompts, "controlled root did not start")
          yield* dag.pause(dagID)
          yield* Deferred.succeed(root.release, "checkpoint")

          const paused = yield* takeWithin(parentPrompts, "paused boundary did not wake the parent")
          expect(promptText(paused.input)).toContain('Node "root" completed: checkpoint')
          yield* Deferred.succeed(paused.release, "success")
          yield* takeWithin(parentSettled, "paused parent prompt did not settle")

          yield* dag.resume(dagID)
          expect(yield* dag.step(dagID)).toEqual({ status: "stepping", nodeID: "next" })
          const next = yield* takeWithin(childPrompts, "stepping boundary did not start the selected node")
          yield* Deferred.succeed(next.release, "stepped")
          const stepped = yield* takeWithin(parentPrompts, "stepping boundary did not wake the parent")
          expect(promptText(stepped.input)).toContain('Node "next" completed: stepped')
          yield* Deferred.succeed(stepped.release, "success")
          yield* takeWithin(parentSettled, "stepping parent prompt did not settle")

          expect((yield* store.getWorkflow(dagID))?.status).toBe("stepping")
          expect((yield* store.getNode(dagID, "after"))?.status).toBe("pending")
        }),
      ),
    )
  })
})
