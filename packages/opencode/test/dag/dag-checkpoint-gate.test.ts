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

// DAG-01 (authoring half): a checkpoint whose output a condition reads must
// declare output_schema. Without it the child completes with a raw string;
// even with the runtime's JSON normalization a prose reply resolves no
// fields, so the `.output.<field>` gate would be permanently false and the
// gated subtree silently skipped while the workflow reports COMPLETED.
it.effect("rejects a gated reporting checkpoint without output_schema", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "schemaless-gate",
        nodes: [
          { ...checkpoint("cp-decision"), output_schema: undefined },
          stage("stage-next", ["cp-decision"], 'cp-decision.output.verdict == "continue"'),
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((d) => d.message.includes('"cp-decision"') && d.message.includes("output_schema"))).toBe(true)
  }),
)

it.effect("accepts a gated reporting checkpoint that declares output_schema", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "schema-gate",
        nodes: [
          checkpoint("cp-decision"),
          stage("stage-next", ["cp-decision"], 'cp-decision.output.verdict == "continue"'),
        ],
      }),
    )
    expect(result.errors.filter((d) => d.message.includes("output_schema"))).toEqual([])
  }),
)

it.effect("does not require output_schema on a reporting leaf checkpoint", () =>
  Effect.gen(function* () {
    const result = yield* validate(
      spec({
        name: "schemaless-leaf",
        nodes: [{ ...checkpoint("cp-final"), depends_on: [], output_schema: undefined }],
      }),
    )
    expect(result.errors.filter((d) => d.message.includes("output_schema"))).toEqual([])
  }),
)

// DAG-02: pre-fix authoring closed ALL structural diagnostics for non-start
// actions (`structural: input.action === "start"`), so a replan/extend could
// attach an ungated dependent to a reporting checkpoint and the engine would
// spawn it the moment the checkpoint completes — the checkpoint gate must
// apply to fragment actions too.
function validateReplan(fragmentGraph: Record<string, unknown>) {
  return WorkflowAuthoring.make().prepare({
    action: "replan",
    source: {
      kind: "inline",
      value: { fragment: fragmentGraph },
      source: "<test>",
    },
  })
}

function validateExtend(value: unknown) {
  return WorkflowAuthoring.make().prepare({
    action: "extend",
    source: { kind: "inline", value, source: "<test>" },
  })
}

it.effect("rejects a replan fragment whose dependent is not gated on the fragment's reporting checkpoint", () =>
  Effect.gen(function* () {
    const result = yield* validateReplan({
      name: "replan-ungated",
      nodes: [checkpoint("cp-review"), stage("stage-fix", ["cp-review"])],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((d) => d.message.includes('"cp-review"') && d.message.includes('"stage-fix"'))).toBe(true)
  }),
)

it.effect("rejects an extend fragment whose dependent is not gated on its reporting checkpoint", () =>
  Effect.gen(function* () {
    const result = yield* validateExtend({
      nodes: [checkpoint("cp-review"), stage("stage-fix", ["cp-review"])],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((d) => d.message.includes('"cp-review"') && d.message.includes('"stage-fix"'))).toBe(true)
  }),
)

it.effect("accepts a replan fragment that gates its dependent on the checkpoint output", () =>
  Effect.gen(function* () {
    const result = yield* validateReplan({
      name: "replan-gated",
      nodes: [
        checkpoint("cp-review"),
        stage("stage-fix", ["cp-review"], 'cp-review.output.verdict == "continue"'),
      ],
    })
    expect(result.errors.filter((d) => d.message.includes("not gated"))).toEqual([])
  }),
)
