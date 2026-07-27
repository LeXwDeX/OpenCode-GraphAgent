import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Dag, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"

const testLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
)

const dagLayer = Layer.provideMerge(Dag.layer, testLayer)

function node(id: string, dependsOn: string[] = []): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
  }
}

// Structural validation fails BEFORE any event is published, so no
// project/session FK rows are needed for the rejection paths.
function createExpectingError(config: Partial<WorkflowConfig> & { nodes: NodeConfig[] }) {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const error = yield* dag.create({
      projectID: "project-1",
      sessionID: "ses_create",
      title: "create-validation",
      config: { name: "create-validation", ...config },
    }).pipe(Effect.catch((e: Error) => Effect.succeed(e)))
    expect(error).toBeInstanceOf(Error)
    return error as Error
  })
}

function setupFKs() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: "ses_create" as never, project_id: Project.ID.global, slug: "create", directory: "/project", title: "create", version: "test" }).run().pipe(Effect.orDie)
  })
}

describe("Dag.create structural validation", () => {
  it("rejects duplicate node ids instead of silently merging them", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* createExpectingError({ nodes: [node("a"), node("b"), node("a")] })
        expect(error.message).toContain("duplicate node ids: a")
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("rejects unknown depends_on references instead of silently dropping the edge", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Pre-fix, buildGraph dropped the edge and a typo'd dependency turned
        // the node into an immediately-runnable root.
        const error = yield* createExpectingError({ nodes: [node("a"), node("b", ["ghost"])] })
        expect(error.message).toContain('node "b" depends on unknown node "ghost"')
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("enforces max_total_nodes at creation, not only on replan", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* createExpectingError({
          max_total_nodes: 2,
          nodes: [node("a"), node("b"), node("c")],
        })
        expect(error.message).toContain("Total node ceiling exceeded: 3 nodes > 2 max")
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("rejects a condition referencing a node outside depends_on", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Pre-fix, the condition would silently resolve to undefined at spawn
        // time and evaluate false — a silent skip instead of a loud rejection.
        const error = yield* createExpectingError({
          nodes: [
            node("gate"),
            node("other"),
            { ...node("impl", ["other"]), condition: 'gate.output.verdict == "ACCEPT"' },
          ],
        })
        expect(error.message).toContain('node "impl" condition references "gate"')
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("accepts a valid config (condition on a direct dependency)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag.create({
          projectID: Project.ID.global,
          sessionID: "ses_create",
          title: "create-validation",
          config: {
            name: "create-validation",
            nodes: [node("gate"), { ...node("impl", ["gate"]), condition: 'gate.output.verdict == "ACCEPT"' }],
          },
        }).pipe(Effect.orDie)
        expect(dagID.startsWith("dag")).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })
})
