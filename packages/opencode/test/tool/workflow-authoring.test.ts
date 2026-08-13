import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { Parameters } from "../../src/tool/workflow"
import { DagBlocks } from "../../src/dag/blocks"

// Regression fixtures for change repair-workflow-authoring-validation.
//
// The worktree-lifecycle task had already produced a complete decision brief
// and correctly selected `plan → coding(2 packages) → verify → review` with
// an explicit explore skip. The route choice was right; every start call then
// failed at the tool boundary:
//
//   1. start carrying an empty workflow_id (Dag.ID entry validation),
//   2. start carrying other actions' fields (operation=complete, node_id,
//      limit),
//   3. start whose inline spec stayed `{}` because the provider-facing
//      schema declared no spec structure.
//
// These fixtures pin the decision brief's route and the two polluted call
// shapes so the discriminated-union schema is measured against them.

const WORKTREE_LIFECYCLE_BRIEF = {
  objective:
    "Repair worktree lifecycle handling: fix bootstrap cleanup races and cover both tiers with regression tests",
  route: ["plan", "coding(worktree-core)", "coding(callers-and-fixture)", "verify", "review"],
  skips: ["explore — the confirmed brief already supplies file references, failure mechanism, package split, risks, and acceptance checks"],
  packages: {
    "worktree-core": "worktree bootstrap/cleanup ownership in the core lifecycle",
    "callers-and-fixture": "call-site updates plus the isolated memory fixture in cli tests",
  },
} as const

const block = (input: {
  id: string
  kind: (typeof DagBlocks.WORKFLOW_BLOCK_KINDS)[number]
  depends_on?: string[]
  instruction?: string
}) => new DagBlocks.WorkflowBlock(input)

// The accepted start fixture: only start-owned fields, complete config.blocks.
const worktreeLifecycleStartInput = {
  action: "start",
  spec: {
    title: "Worktree lifecycle repair",
    config: {
      name: "worktree-lifecycle-repair",
      objective: WORKTREE_LIFECYCLE_BRIEF.objective,
      blocks: [
        block({
          id: "plan",
          kind: "plan",
          instruction: "Use the confirmed brief; do not repeat discovery.",
        }),
        block({
          id: "coding-worktree-core",
          kind: "coding",
          depends_on: ["plan"],
          instruction: WORKTREE_LIFECYCLE_BRIEF.packages["worktree-core"],
        }),
        block({
          id: "coding-callers-and-fixture",
          kind: "coding",
          depends_on: ["plan"],
          instruction: WORKTREE_LIFECYCLE_BRIEF.packages["callers-and-fixture"],
        }),
        block({
          id: "verify",
          kind: "verify",
          depends_on: ["coding-worktree-core", "coding-callers-and-fixture"],
          instruction: "Run the two packages' acceptance commands and record evidence",
        }),
        block({
          id: "review",
          kind: "review",
          depends_on: ["verify"],
        }),
      ],
    },
  },
} as const

// The previously observed polluted calls: a start that carries another
// action's identifiers and control fields. The empty-workflow_id shape
// already fails the Dag.ID brand today; the plausible-id shape passes the
// flat schema and must be rejected once fields become action-owned.
const pollutedStartWithForeignFields = {
  action: "start",
  workflow_id: "dag_2x9k4m",
  operation: "complete",
  node_id: "verify",
  cursor: "",
  limit: 8000,
  spec: worktreeLifecycleStartInput.spec,
}

const pollutedStartWithEmptySpec = {
  action: "start",
  spec: {},
}

// The tool admits parameters with strict parsing (foreign fields are an
// error, not a silent drop), so the fixtures decode the same way.
const decode = (input: unknown) =>
  Result.isSuccess(Schema.decodeUnknownResult(Parameters, { onExcessProperty: "error" })(input))

describe("worktree-lifecycle regression fixtures", () => {
  test("decision brief route compiles under the block compiler", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: WORKTREE_LIFECYCLE_BRIEF.objective,
      blocks: [...worktreeLifecycleStartInput.spec.config.blocks],
    })
    const byID = new Map(nodes.map((node) => [node.id, node]))
    // Workspace-writer serialization: the second coding writer waits for the
    // first even though both only declared the plan dependency.
    const writerOrder = nodes.filter((node) => node.worker_type === "build").map((node) => node.id)
    expect(writerOrder).toEqual(["coding-worktree-core", "coding-callers-and-fixture"])
    expect(byID.get("coding-callers-and-fixture")?.depends_on).toContain("coding-worktree-core")
    // Verification depends on every writer; the review binds to the
    // canonical implementation fingerprint.
    expect(byID.get("verify")?.depends_on).toEqual(
      expect.arrayContaining(["coding-worktree-core", "coding-callers-and-fixture"]),
    )
    const reviewDecision = byID.get("review")
    expect(reviewDecision?.review?.phase).toBe("diff")
    // Canonical writer is the serialized one that transitively depends on
    // every other writer — the second package after serialization.
    expect(reviewDecision?.review?.implementation_node_id).toBe("coding-callers-and-fixture")
    expect(reviewDecision?.review?.verification_node_id).toBe("verify")
    expect(reviewDecision?.input_mapping?.["implementation_fingerprint"]).toBe(
      "coding-callers-and-fixture.output.fingerprint",
    )
  })

  test("accepted start fixture carries only start-owned fields and a complete config.blocks", () => {
    expect(Object.keys(worktreeLifecycleStartInput)).toEqual(["action", "spec"])
    expect(worktreeLifecycleStartInput.spec.config.blocks.length).toBe(5)
    expect(decode(worktreeLifecycleStartInput)).toBe(true)
  })

  test("replay: the complete audit adds no explore block and strict decode keeps a clean start", () => {
    // The confirmed brief already supplies repository evidence, so the route
    // starts at plan — no explore lane is added back.
    const blockIDs = worktreeLifecycleStartInput.spec.config.blocks.map((block) => block.id)
    expect(blockIDs.some((id) => id.includes("explore"))).toBe(false)
    expect(blockIDs).toEqual(["plan", "coding-worktree-core", "coding-callers-and-fixture", "verify", "review"])
    // Strict decoding admits exactly the start-owned fields.
    const decoded = Schema.decodeUnknownSync(Parameters, { onExcessProperty: "error" })(worktreeLifecycleStartInput)
    expect(decoded.action).toBe("start")
    expect("spec" in decoded).toBe(true)
    expect("workflow_id" in decoded).toBe(false)
    expect("operation" in decoded).toBe(false)
    expect("node_id" in decoded).toBe(false)
  })

  test("start polluted with empty workflow/control/result fields is rejected", () => {
    expect(decode(pollutedStartWithForeignFields)).toBe(false)
  })

  test("start with an empty inline spec is rejected", () => {
    expect(decode(pollutedStartWithEmptySpec)).toBe(false)
  })

  test("start without any graph source is rejected", () => {
    expect(decode({ action: "start" })).toBe(false)
  })

  test("validate rejects control and result fields it does not own", () => {
    const spec = worktreeLifecycleStartInput.spec
    expect(decode({ action: "validate", spec, workflow_id: "dag_2x9k4m" })).toBe(false)
    expect(decode({ action: "validate", spec, node_id: "verify" })).toBe(false)
    expect(decode({ action: "validate", spec, operation: "cancel" })).toBe(false)
    expect(decode({ action: "validate", spec, cursor: "", limit: 500 })).toBe(false)
    // The validate action itself stays clean with exactly one source.
    expect(decode({ action: "validate", spec, profile: "portable" })).toBe(true)
    expect(decode({ action: "validate", spec_path: "saved-route", profile: "environment" })).toBe(true)
  })

  test("inline admission rejects boundary-owned audit fields; file reads strip them instead", () => {
    const brief = {
      goal: "Ship the change",
      scope: { in: ["dag"], out: [] },
      constraints: [],
      assumptions: [],
      acceptance_criteria: [],
      evidence_required: [],
      risks: ["unresolved rollout"],
      review_plan: [],
      open_questions: [],
      blocking_questions: [],
    }
    const cleanAdmission = {
      brief_revision: 1,
      qa_mode: "STANDARD",
      verdict: "WAIVED",
      brief,
      waiver_reason: "Preview release only",
      acknowledged_risks: ["unresolved rollout"],
    }
    const spec = { ...worktreeLifecycleStartInput.spec, mode: "deep", admission: cleanAdmission }
    expect(decode({ action: "start", spec })).toBe(true)
    // System-generated fields never belong in the model-facing schema — the
    // file-read boundary strips them for legacy YAML compatibility instead.
    for (const field of ["protocol_version", "state", "fingerprint"]) {
      expect(decode({ action: "start", spec: { ...spec, admission: { ...cleanAdmission, [field]: "x" } } })).toBe(
        false,
      )
    }
  })
})
