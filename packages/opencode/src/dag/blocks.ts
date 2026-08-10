import { Schema } from "effect"
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

export class WorkflowBlock extends Schema.Class<WorkflowBlock>("WorkflowBlock")({
  id: Schema.String.annotate({ description: "Unique block identifier; dependencies target block IDs" }),
  kind: Schema.Literals(WORKFLOW_BLOCK_KINDS).annotate({
    description: "Composable workflow block; debug and review expand into evidence-gathering subgraphs",
  }),
  depends_on: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Block IDs this block waits for. Defaults to []",
  }),
  instruction: Schema.optional(Schema.String).annotate({
    description: "Task-specific instruction added to the block's built-in execution contract",
  }),
  skills: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Relevant skills the child should load lazily before working",
  }),
  worker_type: Schema.optional(Schema.String).annotate({
    description: "Optional configured agent override; defaults from the block kind",
  }),
  required: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether failure is terminal. Decision and verification blocks default to true; volume blocks to false",
  }),
  report_to_parent: Schema.optional(Schema.Boolean).annotate({
    description: "Override wake behavior. Review decisions and synthesis report by default",
  }),
}) {}

export interface WorkflowBlockGraph {
  objective: string
  blocks: WorkflowBlock[]
}

export interface WorkflowBlockCompileOptions {
  known_dependencies?: string[]
}

const GENERAL_VERDICT_SCHEMA = {
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

const IMPLEMENTATION_SCHEMA = {
  type: "object",
  required: ["summary", "changed_files", "fingerprint"],
  properties: {
    summary: { type: "string" },
    changed_files: { type: "array", items: { type: "string" } },
    fingerprint: { type: "string" },
  },
} as const

const VERIFICATION_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "evidence"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    summary: { type: "string" },
    evidence: { type: "array" },
  },
} as const

const DIFF_REVIEW_SCHEMA = {
  type: "object",
  required: ["verdict", "implementation_fingerprint", "summary", "findings", "required_actions"],
  properties: {
    verdict: { type: "string", enum: ["ACCEPT", "REJECT"] },
    implementation_fingerprint: { type: "string" },
    summary: { type: "string" },
    findings: { type: "array" },
    required_actions: { type: "array" },
  },
} as const

const WRITER_KINDS = new Set<WorkflowBlockKind>(["coding", "prototype"])

const BLOCK_CONTRACTS: Record<WorkflowBlockKind, string> = {
  explore:
    "Inspect the target read-only. Map relevant modules, constraints, existing conventions, and evidence with file references. Do not implement.",
  plan: "Produce an implementation-ready plan from repository evidence and dependency outputs. Name seams, work packages, acceptance checks, and unresolved risks. Do not implement.",
  prototype:
    "Build only the smallest throwaway experiment needed to answer the stated uncertainty. Separate observations from production recommendations and do not integrate it unless explicitly instructed.",
  debug:
    "Diagnose the smallest falsifiable root-cause hypothesis from reproduced evidence. Distinguish cause from symptom and identify the narrowest safe repair plus a regression check.",
  coding:
    "Implement the bounded production change. Follow repository instructions, preserve unrelated work, add or update focused tests, and run relevant checks. Submit the aggregate changed-file list and a stable fingerprint of the actual implementation state so downstream verification and review can detect stale evidence.",
  verify:
    "Verify the supplied work against acceptance criteria using deterministic checks where available. Submit commands and evidence with an explicit PASS or FAIL verdict. Do not hide failures.",
  review:
    "Review independently against repository standards and the confirmed intent. Cite concrete evidence, separate blockers from suggestions, and identify claims that still need verification.",
  synthesize:
    "Combine dependency outputs into one decision-ready result. Resolve conflicts using evidence, preserve material uncertainty, and state the outcome, rationale, residual risks, and next action.",
}

export function compileWorkflowBlocks(
  graph: WorkflowBlockGraph,
  options: WorkflowBlockCompileOptions = {},
): NodeConfig[] {
  requireValidBlockGraph(graph, options)
  const blocks = serializeWorkspaceWriters(graph.blocks)
  requireValidReviewRoutes(blocks)
  const nodes = blocks.flatMap((block) => compileBlock(graph.objective, block, blocks))
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
  const required = block.required ?? (block.kind === "plan" || block.kind === "verify" || block.kind === "synthesize")
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
        required: false,
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
        required: block.required ?? true,
        reportToParent: block.report_to_parent ?? false,
      }),
    ]
  }

  if (block.kind === "review") {
    const standardsID = `${block.id}--standards`
    const intentID = `${block.id}--intent`
    const route = implementationReviewRoute(block, blocks)
    const reviewCondition = route ? `${route.verification.id}.output.verdict == "PASS"` : condition
    const reviewEvidence = route
      ? {
          implementation_changed_files: `${route.implementation.id}.output.changed_files`,
          implementation_fingerprint: `${route.implementation.id}.output.fingerprint`,
          verification: `${route.verification.id}.output`,
        }
      : undefined
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
        required: false,
        reportToParent: false,
        condition: reviewCondition,
        inputMapping: reviewEvidence,
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
        required: false,
        reportToParent: false,
        condition: reviewCondition,
        inputMapping: reviewEvidence,
      }),
      node({
        id: block.id,
        name: `${block.id}: review decision`,
        workerType: block.worker_type ?? "general",
        dependencies: [standardsID, intentID, ...(route ? [route.verification.id] : [])],
        objective,
        instruction: block.instruction,
        skills: block.skills,
        contract: [
          "Arbitrate the two independent reviews finding by finding.",
          route
            ? "Reject unsupported claims, deduplicate overlaps, and submit ACCEPT or REJECT while echoing the supplied implementation fingerprint exactly."
            : "Reject unsupported claims, deduplicate overlaps, and submit one structured result with verdict ACCEPT, REVISE, REJECT, or BLOCKED.",
          "Use ACCEPT only when no material required action remains.",
        ].join(" "),
        required: block.required ?? true,
        reportToParent: block.report_to_parent ?? true,
        condition: reviewCondition,
        inputMapping: route
          ? {
              ...reviewEvidence,
              standards_review: `${standardsID}.output`,
              intent_review: `${intentID}.output`,
            }
          : undefined,
        review: route
          ? {
              phase: "diff",
              implementation_node_id: route.implementation.id,
              verification_node_id: route.verification.id,
            }
          : undefined,
        outputSchema: route ? DIFF_REVIEW_SCHEMA : GENERAL_VERDICT_SCHEMA,
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
      outputSchema:
        block.kind === "coding" ? IMPLEMENTATION_SCHEMA : block.kind === "verify" ? VERIFICATION_SCHEMA : undefined,
    }),
  ]
}

function node(input: {
  id: string
  name: string
  workerType: string
  dependencies: readonly string[]
  objective: string
  instruction?: string
  skills?: readonly string[]
  contract: string
  required: boolean
  reportToParent: boolean
  condition?: string
  inputMapping?: Record<string, string>
  review?: NodeConfig["review"]
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
    depends_on: [...input.dependencies],
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
    ...(input.inputMapping ? { input_mapping: input.inputMapping } : {}),
    ...(input.review ? { review: input.review } : {}),
    ...(input.outputSchema ? { output_schema: input.outputSchema } : {}),
  }
}

function workerType(kind: WorkflowBlockKind) {
  if (kind === "explore") return "explore"
  if (kind === "plan") return "plan"
  if (kind === "coding" || kind === "prototype") return "build"
  return "general"
}

function requireValidBlockGraph(graph: WorkflowBlockGraph, options: WorkflowBlockCompileOptions) {
  if (graph.objective.trim() === "") throw new Error("Block workflow requires a non-empty objective")
  if (graph.blocks.length === 0) throw new Error("Block workflow requires at least one block")

  const blockIDs = graph.blocks.map((block) => block.id)
  const duplicateBlockIDs = uniqueDuplicates(blockIDs)
  if (duplicateBlockIDs.length > 0) {
    throw new Error(`Block workflow has duplicate block ids: ${duplicateBlockIDs.join(", ")}`)
  }

  const known = new Set([...blockIDs, ...(options.known_dependencies ?? [])])
  graph.blocks.forEach((block) => {
    if (block.id.trim() === "") throw new Error("Block workflow contains an empty block id")
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(block.id)) {
      throw new Error(`Block "${block.id}" must use only letters, numbers, underscores, and hyphens`)
    }
    ;(block.depends_on ?? []).forEach((dependency) => {
      if (!known.has(dependency)) {
        throw new Error(`Block "${block.id}" depends on unknown block "${dependency}"`)
      }
    })
    const reviewDependencies = (block.depends_on ?? []).filter(
      (dependency) => graph.blocks.find((candidate) => candidate.id === dependency)?.kind === "review",
    )
    if (reviewDependencies.length > 1) {
      throw new Error(
        `Block "${block.id}" depends on multiple review gates (${reviewDependencies.join(", ")}); fan them into one review block first`,
      )
    }
  })
  topologicalBlocks(graph.blocks)
}

function serializeWorkspaceWriters(blocks: WorkflowBlock[]) {
  const writers = topologicalBlocks(blocks).filter((block) => WRITER_KINDS.has(block.kind))
  const previousWriter = new Map(
    writers.slice(1).map((block, index) => [block.id, writers[index]?.id ?? block.id] as const),
  )
  const serialized = blocks.map((block) => {
    const previous = previousWriter.get(block.id)
    if (!previous || dependsTransitively(blocks, block.id, previous)) return block
    return new WorkflowBlock({
      ...block,
      depends_on: [...(block.depends_on ?? []), previous],
    })
  })
  topologicalBlocks(serialized)
  return serialized
}

function requireValidReviewRoutes(blocks: WorkflowBlock[]) {
  blocks.filter((block) => block.kind === "review").forEach((block) => implementationReviewRoute(block, blocks))
}

function implementationReviewRoute(block: WorkflowBlock, blocks: WorkflowBlock[]) {
  const implementations = blocks.filter(
    (candidate) => WRITER_KINDS.has(candidate.kind) && dependsTransitively(blocks, block.id, candidate.id),
  )
  if (implementations.length === 0) return undefined
  const verifications = blocks.filter(
    (candidate) => candidate.kind === "verify" && dependsTransitively(blocks, block.id, candidate.id),
  )
  if (verifications.length !== 1) {
    throw new Error(
      `Implementation review "${block.id}" requires exactly one verification ancestor; found ${verifications.length}`,
    )
  }
  const verification = verifications[0]
  if (!verification) throw new Error(`Implementation review "${block.id}" has no verification ancestor`)
  const verifiedImplementations = implementations.filter((candidate) =>
    dependsTransitively(blocks, verification.id, candidate.id),
  )
  if (verifiedImplementations.length !== implementations.length) {
    throw new Error(
      `Implementation review "${block.id}" requires its verification ancestor to depend on every implementation writer`,
    )
  }
  const implementation = verifiedImplementations.find((candidate) =>
    verifiedImplementations.every(
      (other) => other.id === candidate.id || dependsTransitively(blocks, candidate.id, other.id),
    ),
  )
  if (!implementation) {
    throw new Error(`Implementation review "${block.id}" has no canonical serialized implementation writer`)
  }
  return { implementation, verification }
}

function dependsTransitively(
  blocks: WorkflowBlock[],
  blockID: string,
  dependencyID: string,
  visited = new Set<string>(),
): boolean {
  if (visited.has(blockID)) return false
  const dependencies = blocks.find((block) => block.id === blockID)?.depends_on ?? []
  if (dependencies.includes(dependencyID)) return true
  const nextVisited = new Set([...visited, blockID])
  return dependencies.some((dependency) => dependsTransitively(blocks, dependency, dependencyID, nextVisited))
}

function uniqueDuplicates(values: string[]) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

function topologicalBlocks(blocks: WorkflowBlock[]) {
  const blockIDs = new Set(blocks.map((block) => block.id))
  const ordered: WorkflowBlock[] = []
  const remaining = new Map(
    blocks.map((block) => [
      block.id,
      new Set((block.depends_on ?? []).filter((dependency) => blockIDs.has(dependency))),
    ]),
  )
  while (remaining.size > 0) {
    const ready = blocks.filter((block) => remaining.get(block.id)?.size === 0)
    if (ready.length === 0) {
      throw new Error(`Block workflow contains a dependency cycle involving: ${[...remaining.keys()].join(", ")}`)
    }
    ready.forEach((block) => remaining.delete(block.id))
    remaining.forEach((dependencies) => ready.forEach((block) => dependencies.delete(block.id)))
    ordered.push(...ready)
  }
  return ordered
}

export * as DagBlocks from "./blocks"
