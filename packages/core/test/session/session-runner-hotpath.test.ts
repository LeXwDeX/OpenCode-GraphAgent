import { describe, expect } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  TransportReason,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigAgent } from "@opencode-ai/core/config/agent"
import { Tool } from "@opencode-ai/core/tool/tool"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { Location } from "@opencode-ai/core/location"
import { Cause, DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { and, asc, eq } from "drizzle-orm"
import * as TestClock from "effect/testing/TestClock"
import { testEffect } from "../lib/effect"

const sessionID = SessionV2.ID.make("ses_runner_hotpath")
const requests: LLMRequest[] = []
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      if (responseStream) {
        const stream = responseStream
        responseStream = undefined
        return stream
      }
      return Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

// Counts EventV2 usage at the service boundary so the runner's batching is observable.
const counts = { publish: 0, publishMany: 0 }
const events = Layer.effect(
  EventV2.Service,
  Effect.gen(function* () {
    const service = yield* EventV2.Service
    return EventV2.Service.of({
      ...service,
      publish: <D extends EventV2.Definition>(
        definition: D,
        data: EventV2.Data<D>,
        options?: EventV2.PublishOptions,
      ) => {
        counts.publish++
        return service.publish(definition, data, options)
      },
      publishMany: (batch: ReadonlyArray<EventV2.BatchEvent>, options?: { readonly location?: Location.Ref }) => {
        counts.publishMany++
        return service.publishMany(batch, options)
      },
    })
  }),
).pipe(Layer.provide(EventV2.defaultLayer))

// Scripted snapshots: capture returns the next queued tree ID (default "tree-1",
// i.e. an unchanged tree), files records the compared pair.
const probe = { captures: new Array<string | undefined>(), captureCalls: 0, filesCalls: 0, filesPairs: [] as string[][] }
const snapshot = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    capture: () =>
      Effect.sync(() => {
        probe.captureCalls++
        const value = probe.captures.length > 0 ? probe.captures.shift()! : "tree-1"
        return value === undefined ? undefined : Snapshot.ID.make(value)
      }),
    files: ({ from, to }) =>
      Effect.sync(() => {
        probe.filesCalls++
        probe.filesPairs.push([String(from), String(to)])
        return []
      }),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
  }),
)

// The tool is gated on a Deferred so the test can inspect the durable event
// table while the side effect is running, proving Tool.Called is committed
// before execution.
const executions: string[] = []
let toolExecutionGate: Deferred.Deferred<void> | undefined
const permission = Layer.mock(PermissionV2.Service, {
  assert: () => Effect.die("unused"),
  ask: () => Effect.die("unused"),
  reply: () => Effect.die("unused"),
  get: () => Effect.die("unused"),
  forSession: () => Effect.die("unused"),
  list: () => Effect.die("unused"),
})
const applications = ApplicationTools.layer
const registry = ToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(applications),
  Layer.provide(ToolOutputStore.defaultLayer),
)
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, _context) =>
          Effect.gen(function* () {
            executions.push(text)
            if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
            return { text }
          }),
      }),
    }),
  ),
).pipe(Layer.provide(registry))
const agents = AgentV2.layer
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const systemContext = SystemContextRegistry.layer
const location = Location.layer({ directory: AbsolutePath.make("/project") }).pipe(Layer.provide(Project.defaultLayer))
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
// Config documents are read lazily per turn by the runner, so tests can set
// this before a run to exercise per-agent timeout resolution.
let configEntries: Config.Entry[] = []
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(configEntries) }))
const runner = SessionRunnerLLM.layer.pipe(
  Layer.provide(snapshot),
  Layer.provide(Database.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(events),
  Layer.provide(client),
  Layer.provide(registry),
  Layer.provide(models),
  Layer.provide(systemContext),
  Layer.provide(location),
  Layer.provide(agents),
  Layer.provide(skillGuidance),
  Layer.provide(referenceGuidance),
  Layer.provide(config),
)
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runner))
const sessions = SessionV2.layer.pipe(
  Layer.provide(LocationServiceMap.layer),
  Layer.provide(events),
  Layer.provide(Database.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.provide(execution),
)
const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    events,
    SessionProjector.defaultLayer,
    SessionStore.defaultLayer,
    client,
    permission,
    applications,
    agents,
    registry,
    echo,
    models,
    systemContext,
    location,
    skillGuidance,
    referenceGuidance,
    config,
    runner,
    execution,
    sessions,
  ),
)

const textTurn = (id: string, text: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const toolTurn: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolInputStart({ id: "call-echo", name: "echo" }),
  LLMEvent.toolInputDelta({ id: "call-echo", name: "echo", text: '{"text":"Hi"}' }),
  LLMEvent.toolInputEnd({ id: "call-echo", name: "echo" }),
  LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "Hi" } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  response = []
  responses = undefined
  responseStream = undefined
  requests.length = 0
  counts.publish = 0
  counts.publishMany = 0
  probe.captures = []
  probe.captureCalls = 0
  probe.filesCalls = 0
  probe.filesPairs = []
  executions.length = 0
  toolExecutionGate = undefined
  configEntries = []
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

const durableEventTypes = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()).map((event) => event.type)
  })

const stepEndedData = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, id), eq(EventTable.type, "session.next.step.ended.2")))
      .orderBy(asc(EventTable.seq))
      .all()).map((event) => event.data)
  })

// Bounded readiness poll: yields to forked fibers so they can publish the
// awaited side effect (TestClock-neutral — it does not depend on virtual
// time), and fails loudly instead of spinning forever if the side effect never
// lands. The timeout is a safety net for live runs; under TestClock the loop
// terminates via the condition once the forked fiber has run.
const waitUntil = <R>(check: Effect.Effect<boolean, never, R>, message: string) =>
  Effect.gen(function* () {
    while (!(yield* check)) yield* Effect.yieldNow
  }).pipe(
    Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error(message)) }),
  )

describe("SessionRunnerLLM hot path", () => {
  it.effect("batches durable publishes and preserves order across incremental turns", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = textTurn("text-first", "Hello")
      counts.publish = 0
      counts.publishMany = 0
      yield* session.resume(sessionID)

      // Text turn: one batch per flush boundary (Text.Started; Text.Ended;
      // Step.Ended) instead of one transaction per durable event; only the
      // live delta goes through the single-event publish path.
      expect(counts.publishMany).toBe(3)
      expect(counts.publish).toBe(2)

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      responses = [toolTurn, textTurn("text-done", "Done")]
      counts.publish = 0
      counts.publishMany = 0
      const gate = yield* Deferred.make<void>()
      toolExecutionGate = gate
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* waitUntil(Effect.sync(() => executions.length >= 1), "echo tool never started")
      const { db } = yield* Database.Service
      const committed = (yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.type, "session.next.tool.called.1"))
        .all()
        .pipe(Effect.orDie)).length

      // Tool.Called was durably committed before the side effect started.
      expect(committed).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(run)

      // Tool turn: 3 batches (step+input start, input-end+called flushed before
      // execution, tool success + step ended) plus 3 batches for the
      // continuation text turn; the tool input delta and text delta are the only
      // live publishes.
      expect(counts.publishMany).toBe(6)
      expect(counts.publish).toBe(3)

      // Incremental history is equivalent to the full read: each turn's request
      // carries the complete prior conversation.
      expect(requests).toHaveLength(3)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(requests[2]?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "tool",
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "First" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Hello" }] },
        { type: "user", text: "Second" },
        { type: "assistant", content: [{ type: "tool", id: "call-echo", name: "echo", state: { status: "completed" } }] },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
      ])

      // Durable event sequence matches the pre-batching order (prompt admission
      // events are published by the session layer, not the runner).
      const types = yield* durableEventTypes(sessionID)
      const runnerEvents = types.filter((type) => !type.includes("prompt"))
      expect(runnerEvents).toEqual([
        "session.next.step.started.1",
        "session.next.text.started.1",
        "session.next.text.ended.1",
        "session.next.step.ended.2",
        "session.next.step.started.1",
        "session.next.tool.input.started.1",
        "session.next.tool.input.ended.1",
        "session.next.tool.called.1",
        "session.next.tool.success.1",
        "session.next.step.ended.2",
        "session.next.step.started.1",
        "session.next.text.started.1",
        "session.next.text.ended.1",
        "session.next.step.ended.2",
      ])

      // Unchanged tree: every step reuses the previous tree ID and the diff
      // computation is skipped (files is the empty diff of identical trees).
      expect(probe.filesCalls).toBe(0)
      const ended = yield* stepEndedData(sessionID)
      expect(ended).toHaveLength(3)
      for (const data of ended) {
        expect(data.snapshot).toBe("tree-1")
        expect(data.files).toEqual([])
      }
    }),
  )

  it.effect("resets the history cursor after compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const eventService = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = textTurn("text-first", "Hello")
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* eventService.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* eventService.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      requests.length = 0
      response = textTurn("text-second", "Again")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      const userTexts = requests[0]!.messages
        .filter((message) => message.role === "user")
        .flatMap((message) =>
          message.content.filter((content): content is { type: "text"; text: string } => content.type === "text").map(
            (content) => content.text,
          ),
        )
      expect(userTexts[0]).toContain("<conversation-checkpoint>")
      expect(userTexts[0]).toContain("summary")
      expect(userTexts[1]).toBe("Second")
      // The compaction moved the read window: pre-compaction messages are gone
      // from the request, proving the cursor reset re-read from the compaction.
      expect(userTexts.join(" ")).not.toContain("First")
    }),
  )

  it.effect("reuses snapshot IDs and skips unchanged-tree diffs across steps", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = textTurn("text-first", "Hello")
      yield* session.resume(sessionID)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      response = textTurn("text-second", "Again")
      yield* session.resume(sessionID)

      expect(probe.captureCalls).toBe(4)
      expect(probe.filesCalls).toBe(0)
      const ended = yield* stepEndedData(sessionID)
      expect(ended.map((data) => data.snapshot)).toEqual(["tree-1", "tree-1"])
      expect(ended.map((data) => data.files)).toEqual([[], []])
    }),
  )

  it.effect("computes real files for a changed tree", () =>
    Effect.gen(function* () {
      yield* setup
      probe.captures = ["tree-1", "tree-2"]
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = textTurn("text-first", "Hello")
      yield* session.resume(sessionID)

      expect(probe.filesCalls).toBe(1)
      expect(probe.filesPairs).toEqual([["tree-1", "tree-2"]])
      const [ended] = yield* stepEndedData(sessionID)
      expect(ended.snapshot).toBe("tree-2")
      expect(ended.files).toEqual([])
    }),
  )

  it.effect("fails a hung provider turn through the provider failure path after the deadline", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      responseStream = Stream.never
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* waitUntil(Effect.sync(() => requests.length >= 1), "provider stream never started")
      yield* TestClock.adjust(Duration.minutes(11))
      const exit = yield* Fiber.await(run)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(LLMError)
        if (error instanceof LLMError) {
          expect(error.reason._tag).toBe("Transport")
          if (error.reason._tag === "Transport") {
            expect(error.reason.message).toBe("Provider turn timed out")
            expect(error.reason.kind).toBe("Timeout")
          }
        }
      }
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "First" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider turn timed out" } },
      ])
    }),
  )

  it.effect("applies the configured agent timeout and bounds a hung tool wait", () =>
    Effect.gen(function* () {
      yield* setup
      // 1-second turn deadline via the `agents.build.timeout` config field
      // (seconds); the DAG-default mirror is 10 minutes when unset.
      configEntries = [new Config.Document({ type: "document", info: { agents: { build: new ConfigAgent.Info({ timeout: 1 }) } } })]
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = toolTurn
      const gate = yield* Deferred.make<void>()
      toolExecutionGate = gate
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* waitUntil(Effect.sync(() => requests.length >= 1), "provider stream never started")
      expect(Duration.toSeconds(requests[0]!.http!.timeout!)).toBe(1)
      // The tool call started and is stuck on the never-released gate; the
      // provider stream itself has finished (only the tool wait remains).
      yield* waitUntil(Effect.sync(() => executions.length >= 1), "echo tool never started")
      yield* TestClock.adjust(Duration.seconds(2))
      const exit = yield* Fiber.await(run)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(LLMError)
        if (error instanceof LLMError) {
          expect(error.reason._tag).toBe("Transport")
          if (error.reason._tag === "Transport") {
            expect(error.reason.message).toBe("Tool execution timed out")
            expect(error.reason.kind).toBe("Timeout")
          }
        }
      }
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "First" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              state: { status: "error", error: { type: "unknown", message: "Tool execution failed: SessionRunner.stream: Tool execution timed out" } },
            },
          ],
        },
      ])
    }),
  )
})
