import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { DagStore } from "@opencode-ai/core/dag/store"
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"

describe("Dag.Service workflow lock", () => {
  it("serializes concurrent extend operations for the same workflow", async () => {
    let activeReads = 0
    let maxActiveReads = 0
    const config = JSON.stringify({ name: "lock-test", nodes: [] })
    const store = Layer.mock(DagStore.Service, {
      getWorkflow: () =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            activeReads += 1
            maxActiveReads = Math.max(maxActiveReads, activeReads)
          })
          yield* Effect.sleep("25 millis").pipe(
            Effect.ensuring(
              Effect.sync(() => {
                activeReads -= 1
              }),
            ),
          )
          return { id: "wf1", status: "running", config }
        }) as never,
      getNodes: () => Effect.succeed([]) as never,
    })
    const events = Layer.succeed(
      EventV2Bridge.Service,
      EventV2Bridge.Service.of({
        publish: () => Effect.succeed({ seq: 1 }),
      } as never),
    )
    const layer = Dag.layer.pipe(Layer.provide(events), Layer.provide(store))

    await Effect.runPromise(
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const node = (id: string) => ({
          id,
          name: id,
          worker_type: "build",
          depends_on: [],
          required: true,
          prompt_template: { inline: id },
        })

        yield* Effect.all(
          [dag.extend("wf1", [node("first")]), dag.extend("wf1", [node("second")])],
          { concurrency: "unbounded" },
        )

        expect(maxActiveReads).toBe(1)
      }).pipe(Effect.provide(layer)) as Effect.Effect<never>,
    )
  })
})
