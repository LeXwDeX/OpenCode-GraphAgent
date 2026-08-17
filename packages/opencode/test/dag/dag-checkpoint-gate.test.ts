import { expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { WorkflowAuthoring } from "../../src/dag/authoring"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

// A report_to_parent (wake-eligible) checkpoint hands its verdict to the
// parent. When a dependent lacks a condition on that checkpoint's output, the
// engine spawns it the moment the checkpoint completes and the verdict can
// never act first — exactly the shape that ran a 6-stage "ultra flow" to
// completion after every decision checkpoint returned replan. Block-compiled
// graphs gate dependents on the verdict (issue #294 REJECT-checkpoint shape);
// hand-built node graphs must do the same.

function spec(config: Record<string, unknown>) {
  return { title: "checkpoint gate", config }
}

function checkpoint(id: string) {
  return {
    id,
    name: id,
    worker_type: "general",
    depends_on: [],
    report_to_parent: true,
    prompt_template: { inline: id },
    output_schema: {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    },
  }
}

function stage(id: string, dependsOn: string[], condition?: string) {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    prompt_template: { inline: id },
    ...(condition ? { condition } : {}),
  }
}

function validate(value: unknown) {
  return WorkflowAuthoring.make().prepare({
    action: "start",
    source: { kind: "inline", value, source: "<test>" },
  })
}

it.effect("rejects a reporting checkpoint whose dependent is not gated on its output", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "ungated-checkpoint",
        nodes: [checkpoint("cp-design-decision"), stage("stage-development", ["cp-design-decision"])],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((d) => d.message.includes('"cp-design-decision"') && d.message.includes('"stage-development"'))).toBe(true)
  }),
)

it.effect("accepts a dependent gated by a condition on the checkpoint output", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "gated-checkpoint",
        nodes: [
          checkpoint("cp-design-decision"),
          stage("stage-development", ["cp-design-decision"], 'cp-design-decision.output.verdict == "continue"'),
        ],
      }),
    )
    expect(result.errors.filter((d) => d.message.includes("not gated"))).toEqual([])
  }),
)

it.effect("accepts a reporting checkpoint as a leaf", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "leaf-checkpoint",
        nodes: [stage("stage-design", []), { ...checkpoint("cp-after-design"), depends_on: ["stage-design"] }],
      }),
    )
    expect(result.errors.filter((d) => d.message.includes("not gated"))).toEqual([])
  }),
)

it.effect("accepts an ungated dependent when the checkpoint does not report to parent", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "quiet-node",
        nodes: [{ ...checkpoint("analysis"), report_to_parent: false }, stage("summary", ["analysis"])],
      }),
    )
    expect(result.errors.filter((d) => d.message.includes("not gated"))).toEqual([])
  }),
)

it.effect("flags ungated dependents inherited from node_defaults.report_to_parent", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "defaults-inherited",
        node_defaults: { report_to_parent: true },
        nodes: [
          { ...checkpoint("cp"), report_to_parent: undefined },
          stage("after", ["cp"]),
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((d) => d.message.includes('"cp"') && d.message.includes('"after"'))).toBe(true)
  }),
)

it.effect("flags a condition that gates a different dependency than the checkpoint", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "wrong-gate",
        nodes: [
          checkpoint("cp-design-decision"),
          stage("stage-design", []),
          stage("stage-development", ["cp-design-decision", "stage-design"], 'stage-design.output.ready == "yes"'),
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((d) => d.message.includes('"cp-design-decision"') && d.message.includes('"stage-development"'))).toBe(true)
  }),
)
