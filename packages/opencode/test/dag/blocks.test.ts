import { describe, expect, it } from "bun:test"
import { compileWorkflowBlocks } from "@/dag/blocks"

describe("workflow blocks", () => {
  it("compiles a staged route and carries objective, instructions, skills, and dependencies", () => {
    const nodes = compileWorkflowBlocks({
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
    expect(nodes.every((node) => node.required)).toBe(true)
  })

  it("expands debug into evidence and diagnosis nodes", () => {
    const nodes = compileWorkflowBlocks({
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
    const nodes = compileWorkflowBlocks({
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

  it("rejects ambiguous dependencies and expansion collisions", () => {
    expect(() =>
      compileWorkflowBlocks({
        objective: "Invalid graph",
        blocks: [{ id: "build", kind: "coding", depends_on: ["missing"] }],
      }),
    ).toThrow('Block "build" depends on unknown block "missing"')

    expect(() =>
      compileWorkflowBlocks({
        objective: "Colliding graph",
        blocks: [
          { id: "check", kind: "review" },
          { id: "check--intent", kind: "verify" },
        ],
      }),
    ).toThrow("Block expansion creates duplicate node ids: check--intent")

    expect(() =>
      compileWorkflowBlocks({
        objective: "Cyclic graph",
        blocks: [
          { id: "a", kind: "plan", depends_on: ["b"] },
          { id: "b", kind: "plan", depends_on: ["a"] },
        ],
      }),
    ).toThrow("dependency cycle")

    expect(() =>
      compileWorkflowBlocks({
        objective: "Unsafe ID",
        blocks: [{ id: "review.output", kind: "review" }],
      }),
    ).toThrow("must use only letters")
  })

  it("allows an extension block to depend on an existing durable node", () => {
    const nodes = compileWorkflowBlocks(
      {
        objective: "Continue from durable evidence",
        blocks: [{ id: "repair", kind: "coding", depends_on: ["existing-evidence"] }],
      },
      { known_dependencies: ["existing-evidence"] },
    )

    expect(nodes[0]?.depends_on).toEqual(["existing-evidence"])
  })

  it("requires one objective and one review dependency per continuation", () => {
    expect(() => compileWorkflowBlocks({ objective: " ", blocks: [{ id: "x", kind: "coding" }] })).toThrow(
      "non-empty objective",
    )
    expect(() =>
      compileWorkflowBlocks({
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
