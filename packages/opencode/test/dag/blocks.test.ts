import { describe, expect, it } from "bun:test"
import { DagBlocks } from "@/dag/blocks"
import { DagConfig } from "@/dag/config"

describe("workflow blocks", () => {
  it("compiles a staged route and carries objective, instructions, skills, and dependencies", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Add durable session recovery",
      blocks: [
        {
          id: "map",
          kind: "explore",
          instruction: "Locate persistence ownership",
        },
        {
          id: "build",
          kind: "coding",
          depends_on: ["map"],
          skills: ["tdd"],
        },
        {
          id: "verify",
          kind: "verify",
          depends_on: ["build"],
        },
      ],
    })

    expect(nodes.map((node) => ({ id: node.id, worker: node.worker_type, dependsOn: node.depends_on }))).toEqual([
      { id: "map", worker: "explore", dependsOn: [] },
      { id: "build", worker: "build", dependsOn: ["map"] },
      { id: "verify", worker: "general", dependsOn: ["build"] },
    ])
    expect(nodes[0]?.prompt_template.input).toEqual({
      objective: "Add durable session recovery",
      instruction: "Locate persistence ownership",
    })
    expect(nodes[1]?.prompt_template.inline).toContain("load these relevant skills")
    expect(nodes[1]?.prompt_template.inline).toContain("tdd")
    expect(nodes.map((node) => ({ id: node.id, required: node.required }))).toEqual([
      { id: "map", required: false },
      { id: "build", required: false },
      { id: "verify", required: true },
    ])
  })

  it("expands debug into evidence and diagnosis nodes", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Find the source of a timeout",
      blocks: [{ id: "root-cause", kind: "debug", report_to_parent: true }],
    })

    expect(nodes.map((node) => node.id)).toEqual(["root-cause--evidence", "root-cause"])
    expect(nodes[0]).toMatchObject({
      worker_type: "explore",
      depends_on: [],
      report_to_parent: false,
    })
    expect(nodes[1]).toMatchObject({
      worker_type: "general",
      depends_on: ["root-cause--evidence"],
      report_to_parent: true,
    })
  })

  it("expands review into two independent lanes and a reporting verdict gate", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Review the implementation",
      blocks: [
        { id: "implementation", kind: "coding" },
        { id: "decision", kind: "review", depends_on: ["implementation"] },
        { id: "report", kind: "synthesize", depends_on: ["decision"] },
      ],
    })

    expect(nodes.map((node) => node.id)).toEqual([
      "implementation",
      "decision--standards",
      "decision--intent",
      "decision",
      "report",
    ])
    expect(nodes.find((node) => node.id === "decision")).toMatchObject({
      depends_on: ["decision--standards", "decision--intent"],
      required: true,
      report_to_parent: true,
      output_schema: {
        type: "object",
        properties: {
          verdict: { enum: ["ACCEPT", "REVISE", "REJECT", "BLOCKED"] },
        },
      },
    })
    expect(nodes.find((node) => node.id === "report")?.condition).toBe('decision.output.verdict == "ACCEPT"')
  })

  it("routes volume blocks to the standard tier and decision blocks to the advanced tier", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Deliver a reviewed project change",
      blocks: [
        { id: "map", kind: "explore" },
        { id: "plan", kind: "plan", depends_on: ["map"] },
        { id: "experiment", kind: "prototype", depends_on: ["map"] },
        { id: "diagnose", kind: "debug", depends_on: ["map"] },
        { id: "build", kind: "coding", depends_on: ["plan", "diagnose"] },
        { id: "verify", kind: "verify", depends_on: ["build", "experiment"] },
        { id: "decision", kind: "review", depends_on: ["verify"] },
        { id: "report", kind: "synthesize", depends_on: ["decision"] },
      ],
    })
    const models = Object.fromEntries(
      nodes.map((node) => [
        node.id,
        DagConfig.tierModel(
          { model: { advanced: "test/advanced", standard: "test/standard" } },
          { required: node.required ?? false, workerType: node.worker_type },
        )?.modelID,
      ]),
    )

    expect(models).toEqual({
      map: "standard",
      plan: "advanced",
      experiment: "standard",
      "diagnose--evidence": "standard",
      diagnose: "advanced",
      build: "standard",
      verify: "advanced",
      "decision--standards": "standard",
      "decision--intent": "standard",
      decision: "advanced",
      report: "advanced",
    })
  })

  it("rejects ambiguous dependencies and expansion collisions", () => {
    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Invalid graph",
        blocks: [{ id: "build", kind: "coding", depends_on: ["missing"] }],
      }),
    ).toThrow('Block "build" depends on unknown block "missing"')

    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Colliding graph",
        blocks: [
          { id: "check", kind: "review" },
          { id: "check--intent", kind: "verify" },
        ],
      }),
    ).toThrow("Block expansion creates duplicate node ids: check--intent")

    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Cyclic graph",
        blocks: [
          { id: "a", kind: "plan", depends_on: ["b"] },
          { id: "b", kind: "plan", depends_on: ["a"] },
        ],
      }),
    ).toThrow("dependency cycle")

    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Unsafe ID",
        blocks: [{ id: "review.output", kind: "review" }],
      }),
    ).toThrow("must use only letters")
  })

  it("allows an extension block to depend on an existing durable node", () => {
    const nodes = DagBlocks.compileWorkflowBlocks(
      {
        objective: "Continue from durable evidence",
        blocks: [{ id: "repair", kind: "coding", depends_on: ["existing-evidence"] }],
      },
      { known_dependencies: ["existing-evidence"] },
    )

    expect(nodes[0]?.depends_on).toEqual(["existing-evidence"])
  })

  it("requires one objective and one review dependency per continuation", () => {
    expect(() => DagBlocks.compileWorkflowBlocks({ objective: " ", blocks: [{ id: "x", kind: "coding" }] })).toThrow(
      "non-empty objective",
    )
    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Ambiguous gates",
        blocks: [
          { id: "review-a", kind: "review" },
          { id: "review-b", kind: "review" },
          { id: "build", kind: "coding", depends_on: ["review-a", "review-b"] },
        ],
      }),
    ).toThrow("depends on multiple review gates")
  })
})
