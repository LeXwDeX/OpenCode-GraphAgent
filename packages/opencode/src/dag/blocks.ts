import type { NodeConfig } from "./dag"

export const WORKFLOW_BLOCK_KINDS = [
  "explore",
  "plan",
  "prototype",
  "debug",
  "coding",
  "verify",
  "review",
  "synthesize",
] as const

export type WorkflowBlockKind = (typeof WORKFLOW_BLOCK_KINDS)[number]

export interface WorkflowBlock {
  id: string
  kind: WorkflowBlockKind
  depends_on?: string[]
  instruction?: string
  skills?: string[]
  worker_type?: string
  required?: boolean
  report_to_parent?: boolean
}

export interface WorkflowBlockGraph {
  objective: string
  blocks: WorkflowBlock[]
}

export interface WorkflowBlockCompileOptions {
  known_dependencies?: string[]
}

const VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "findings", "required_actions"],
  properties: {
    verdict: {
      type: "string",
      enum: ["ACCEPT", "REVISE", "REJECT", "BLOCKED"],
    },
    summary: { type: "string" },
    findings: { type: "array" },
    required_actions: { type: "array" },
  },
} as const

const BLOCK_CONTRACTS: Record<WorkflowBlockKind, string> = {
  explore:
    "Inspect the target read-only. Map relevant modules, constraints, existing conventions, and evidence with file references. Do not implement.",
  plan: "Produce an implementation-ready plan from repository evidence and dependency outputs. Name seams, work packages, acceptance checks, and unresolved risks. Do not implement.",
  prototype:
    "Build only the smallest throwaway experiment needed to answer the stated uncertainty. Separate observations from production recommendations and do not integrate it unless explicitly instructed.",
  debug:
    "Diagnose the smallest falsifiable root-cause hypothesis from reproduced evidence. Distinguish cause from symptom and identify the narrowest safe repair plus a regression check.",
  coding:
    "Implement the bounded production change. Follow repository instructions, preserve unrelated work, add or update focused tests, run relevant checks, and report changed files plus evidence.",
  verify:
    "Verify the supplied work against acceptance criteria using deterministic checks where available. Report commands, results, uncovered claims, and a clear PASS or FAIL conclusion. Do not hide failures.",
  review:
    "Review independently against repository standards and the confirmed intent. Cite concrete evidence, separate blockers from suggestions, and identify claims that still need verification.",
  synthesize:
    "Combine dependency outputs into one decision-ready result. Resolve conflicts using evidence, preserve material uncertainty, and state the outcome, rationale, residual risks, and next action.",
}

export function compileWorkflowBlocks(
  graph: WorkflowBlockGraph,
  options: WorkflowBlockCompileOptions = {},
): NodeConfig[] {
  if (graph.objective.trim() === "") throw new Error("Block workflow requires a non-empty objective")
  if (graph.blocks.length === 0) throw new Error("Block workflow requires at least one block")

  const blockIDs = graph.blocks.map((block) => block.id)
  const duplicateBlockIDs = uniqueDuplicates(blockIDs)
  if (duplicateBlockIDs.length > 0) {
    throw new Error(`Block workflow has duplicate block ids: ${duplicateBlockIDs.join(", ")}`)
  }

  const known = new Set([...blockIDs, ...(options.known_dependencies ?? [])])
  for (const block of graph.blocks) {
    if (block.id.trim() === "") throw new Error("Block workflow contains an empty block id")
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(block.id)) {
      throw new Error(`Block "${block.id}" must use only letters, numbers, underscores, and hyphens`)
    }
    for (const dependency of block.depends_on ?? []) {
      if (!known.has(dependency)) {
        throw new Error(`Block "${block.id}" depends on unknown block "${dependency}"`)
      }
    }
    const reviewDependencies = (block.depends_on ?? []).filter(
      (dependency) => graph.blocks.find((candidate) => candidate.id === dependency)?.kind === "review",
    )
    if (reviewDependencies.length > 1) {
      throw new Error(
        `Block "${block.id}" depends on multiple review gates (${reviewDependencies.join(", ")}); fan them into one review block first`,
      )
    }
  }
  assertAcyclic(graph.blocks)

  const nodes = graph.blocks.flatMap((block) => compileBlock(graph.objective, block, graph.blocks))
  const duplicateNodeIDs = uniqueDuplicates(nodes.map((node) => node.id))
  if (duplicateNodeIDs.length > 0) {
    throw new Error(
      `Block expansion creates duplicate node ids: ${duplicateNodeIDs.join(", ")}. Rename the colliding block`,
    )
  }
  return nodes
}

function compileBlock(objective: string, block: WorkflowBlock, blocks: WorkflowBlock[]): NodeConfig[] {
  const dependencies = block.depends_on ?? []
  const required = block.required ?? true
  const reviewDependency = dependencies.find(
    (dependency) => blocks.find((candidate) => candidate.id === dependency)?.kind === "review",
  )
  const condition = reviewDependency ? `${reviewDependency}.output.verdict == "ACCEPT"` : undefined

  if (block.kind === "debug") {
    const evidenceID = `${block.id}--evidence`
    return [
      node({
        id: evidenceID,
        name: `${block.id}: reproduce and collect evidence`,
        workerType: block.worker_type ?? "explore",
        dependencies,
        objective,
        instruction: block.instruction,
        skills: block.skills,
        contract:
          "Reproduce or characterize the failure read-only where possible. Capture exact symptoms, commands, logs, boundaries, and the smallest falsifiable observations. Do not patch the code.",
        required,
        reportToParent: false,
        condition,
      }),
      node({
        id: block.id,
        name: `${block.id}: diagnose root cause`,
        workerType: block.worker_type ?? "general",
        dependencies: [evidenceID],
        objective,
        instruction: block.instruction,
        skills: block.skills,
        contract: BLOCK_CONTRACTS.debug,
        required,
        reportToParent: block.report_to_parent ?? false,
      }),
    ]
  }

  if (block.kind === "review") {
    const standardsID = `${block.id}--standards`
    const intentID = `${block.id}--intent`
    return [
      node({
        id: standardsID,
        name: `${block.id}: standards review`,
        workerType: block.worker_type ?? "general",
        dependencies,
        objective,
        instruction: block.instruction,
        skills: block.skills,
        contract: `${BLOCK_CONTRACTS.review} Focus on documented repository standards, architecture constraints, correctness, and verification evidence.`,
        required,
        reportToParent: false,
        condition,
      }),
      node({
        id: intentID,
        name: `${block.id}: intent review`,
        workerType: block.worker_type ?? "general",
        dependencies,
        objective,
        instruction: block.instruction,
        skills: block.skills,
        contract: `${BLOCK_CONTRACTS.review} Focus on the confirmed goal, scope, acceptance criteria, and user-visible behavior.`,
        required,
        reportToParent: false,
        condition,
      }),
      node({
        id: block.id,
        name: `${block.id}: review decision`,
        workerType: block.worker_type ?? "general",
        dependencies: [standardsID, intentID],
        objective,
        instruction: block.instruction,
        skills: block.skills,
        contract: [
          "Arbitrate the two independent reviews finding by finding.",
          "Reject unsupported claims, deduplicate overlaps, and submit one structured result with verdict ACCEPT, REVISE, REJECT, or BLOCKED.",
          "Use ACCEPT only when no material required action remains.",
        ].join(" "),
        required,
        reportToParent: block.report_to_parent ?? true,
        outputSchema: VERDICT_SCHEMA,
      }),
    ]
  }

  return [
    node({
      id: block.id,
      name: `${block.id}: ${block.kind}`,
      workerType: block.worker_type ?? workerType(block.kind),
      dependencies,
      objective,
      instruction: block.instruction,
      skills: block.skills,
      contract: BLOCK_CONTRACTS[block.kind],
      required,
      reportToParent: block.report_to_parent ?? block.kind === "synthesize",
      condition,
    }),
  ]
}

function node(input: {
  id: string
  name: string
  workerType: string
  dependencies: string[]
  objective: string
  instruction?: string
  skills?: string[]
  contract: string
  required: boolean
  reportToParent: boolean
  condition?: string
  outputSchema?: Record<string, unknown>
}): NodeConfig {
  const skillInstruction = input.skills?.length
    ? `Before working, load these relevant skills with the skill tool when available: ${input.skills.join(", ")}. If one is unavailable, state that limitation and continue from repository evidence.`
    : ""
  const instruction = input.instruction?.trim() ? "Block-specific instruction:\n{{instruction}}" : ""
  return {
    id: input.id,
    name: input.name,
    worker_type: input.workerType,
    depends_on: input.dependencies,
    required: input.required,
    report_to_parent: input.reportToParent,
    prompt_template: {
      inline: [
        "Workflow objective:\n{{objective}}",
        instruction,
        skillInstruction,
        input.contract,
        "Use dependency outputs as evidence and return a concise artifact that downstream blocks can consume. Do not ask the user questions from this child session.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      input: {
        objective: input.objective,
        ...(input.instruction?.trim() ? { instruction: input.instruction.trim() } : {}),
      },
    },
    ...(input.condition ? { condition: input.condition } : {}),
    ...(input.outputSchema ? { output_schema: input.outputSchema } : {}),
  }
}

function workerType(kind: WorkflowBlockKind) {
  if (kind === "explore") return "explore"
  if (kind === "plan") return "plan"
  if (kind === "coding" || kind === "prototype") return "build"
  return "general"
}

function uniqueDuplicates(values: string[]) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

function assertAcyclic(blocks: WorkflowBlock[]) {
  const blockIDs = new Set(blocks.map((block) => block.id))
  const remaining = new Map(
    blocks.map((block) => [
      block.id,
      new Set((block.depends_on ?? []).filter((dependency) => blockIDs.has(dependency))),
    ]),
  )
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id)
    if (ready.length === 0) {
      throw new Error(`Block workflow contains a dependency cycle involving: ${[...remaining.keys()].join(", ")}`)
    }
    for (const id of ready) remaining.delete(id)
    for (const dependencies of remaining.values()) {
      for (const id of ready) dependencies.delete(id)
    }
  }
}
