// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- service mocks use the narrow runtime surface exercised here
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { awaitWithTimeout, it, pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

interface PromptRecord {
  readonly title: string
  readonly text: string
  readonly release: Deferred.Deferred<string>
}

function node(id: string, dependsOn: string[] = [], inputMapping?: Record<string, string>): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    ...(inputMapping ? { input_mapping: inputMapping } : {}),
  }
}

function reply(sessionID: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "done" }],
  } as never
}

function runtimeLayer(records: Queue.Queue<PromptRecord>, created: string[]) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, status, dag)
  const titles = new Map<string, string>()
  const session = Layer.mock(Session.Service, {
    get: () => Effect.succeed({ id: "ses_mapping_parent", permission: [], agent: "build" } as never),
    create: (input) =>
      Effect.sync(() => {
        const id = `ses_mapping_child_${created.length + 1}`
        created.push(id)
        titles.set(id, (input?.title ?? id).replace(" (DAG node)", ""))
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.mapping")(function* (input: SessionPrompt.PromptInput) {
    const sessionID = input.sessionID as string
    if (sessionID === "ses_mapping_parent") return reply(sessionID)
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(records, {
      title: titles.get(sessionID) ?? sessionID,
      text: input.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      release,
    })
    yield* Deferred.await(release)
    return reply(sessionID)
  })
  const prompt = Layer.mock(
    SessionPrompt.Service,
    withIdleAdmission({
      cancel: () => Effect.void,
      prompt: deliver,
      promptIfIdle: (input) => deliver(input).pipe(Effect.map(Option.some)),
    }),
  )
  const agent = Layer.mock(Agent.Service, {
    get: () =>
      Effect.succeed({
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

function runLoopTest<A>(
  test: (services: {
    dag: Dag.Interface
    loop: DagLoop.Interface
    store: DagStore.Interface
    records: Queue.Queue<PromptRecord>
    created: string[]
  }) => Effect.Effect<A, Error>,
) {
  return Effect.gen(function* () {
    const records = yield* Queue.unbounded<PromptRecord>()
    const created: string[] = []
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionID.make("ses_mapping_parent"),
          project_id: Project.ID.global,
          slug: "mapping-parent",
          directory: process.cwd(),
          title: "Mapping parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      return yield* test({ dag, loop, store, records, created })
    }).pipe(
      Effect.provide(runtimeLayer(records, created)),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: Project.ID.global },
      } as never),
      Effect.scoped,
    )
  })
}

describe("DagLoop input_mapping execution boundary", () => {
  it.live("fails a missing declared field before creating a child session", () =>
    runLoopTest(({ dag, loop, store, records, created }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* dag.create({
          projectID: Project.ID.global,
          sessionID: "ses_mapping_parent",
          title: "Missing mapping field",
          config: {
            name: "missing-mapping-field",
            nodes: [node("producer"), node("consumer", ["producer"], { requiredValue: "producer.output.value" })],
          },
        })
        const producer = yield* awaitWithTimeout(Queue.take(records), "producer did not start")
        expect(producer.title).toBe("producer")
        yield* dag.nodeCompleted(dagID, "producer", { other: 1 })

        const failed = yield* pollWithTimeout(
          store.getNode(dagID, "consumer").pipe(Effect.map((row) => (row?.status === "failed" ? row : undefined))),
          "consumer did not fail its missing input mapping",
        )
        expect(failed.errorReason).toContain(
          'input_mapping variable "requiredValue" source "producer.output.value" resolved to undefined',
        )
        expect(failed.errorClass).toBe("exec_failed")
        expect(created).toEqual(["ses_mapping_child_1"])
        expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
      }),
    ),
  )

  it.live("preserves a completed null whole output as a declared value", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* dag.create({
          projectID: Project.ID.global,
          sessionID: "ses_mapping_parent",
          title: "Null whole output",
          config: {
            name: "null-whole-output",
            nodes: [node("producer"), node("consumer", ["producer"], { whole: "producer.output" })],
          },
        })
        const producer = yield* awaitWithTimeout(Queue.take(records), "producer did not start")
        expect(producer.title).toBe("producer")
        yield* dag.nodeCompleted(dagID, "producer", null)

        const consumer = yield* awaitWithTimeout(Queue.take(records), "null-output consumer did not start")
        expect(consumer.title).toBe("consumer")
        expect(consumer.text).toContain('"whole": null')
        yield* Deferred.succeed(consumer.release, "consumer done")
        yield* pollWithTimeout(
          store.getNode(dagID, "consumer").pipe(Effect.map((row) => (row?.status === "completed" ? row : undefined))),
          "null-output consumer did not complete",
        )
      }),
    ),
  )

  it.live("resolves direct and transitive sources while preserving a null leaf", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* dag.create({
          projectID: Project.ID.global,
          sessionID: "ses_mapping_parent",
          title: "Valid mappings",
          config: {
            name: "valid-mappings",
            nodes: [
              node("producer"),
              node("middle", ["producer"]),
              node("direct", ["producer"], { value: "producer.output.value" }),
              node("transitive", ["middle"], { nullable: "producer.output.nullable" }),
            ],
          },
        })
        const producer = yield* awaitWithTimeout(Queue.take(records), "producer did not start")
        expect(producer.title).toBe("producer")
        yield* dag.nodeCompleted(dagID, "producer", { value: 7, nullable: null })

        const first = yield* awaitWithTimeout(Queue.take(records), "first direct dependent did not start")
        const second = yield* awaitWithTimeout(Queue.take(records), "second direct dependent did not start")
        const direct = [first, second].find((record) => record.title === "direct")
        const middle = [first, second].find((record) => record.title === "middle")
        expect(middle).toBeDefined()
        expect(direct?.text).toContain('"value": 7')
        yield* Deferred.succeed(direct!.release, "direct done")
        yield* Deferred.succeed(middle!.release, "middle done")

        const transitive = yield* awaitWithTimeout(Queue.take(records), "transitive dependent did not start")
        expect(transitive.title).toBe("transitive")
        expect(transitive.text).toContain('"nullable": null')
        yield* Deferred.succeed(transitive.release, "transitive done")
        yield* pollWithTimeout(
          Effect.all([store.getNode(dagID, "direct"), store.getNode(dagID, "transitive")]).pipe(
            Effect.map((rows) => (rows.every((row) => row?.status === "completed") ? rows : undefined)),
          ),
          "valid mapped consumers did not complete",
        )
      }),
    ),
  )
})
