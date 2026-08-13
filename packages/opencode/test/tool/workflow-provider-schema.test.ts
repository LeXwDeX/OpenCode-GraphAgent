/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- These wire-shape tests intentionally traverse provider-owned recursive JSON Schema values and pinned JSON evidence. */
import { describe, expect, test } from "bun:test"
import { Parameters } from "../../src/tool/workflow"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { ProviderTransform } from "../../src/provider/transform"

// Wire-shape regression for change repair-workflow-authoring-validation:
// the discriminated union must survive provider transformation — every action
// keeps its discriminator and required fields, and nested block/node fields
// stay visible to the model (the pre-change Record spec collapsed to
// `properties: {}` on OpenAI — see fixtures/workflow-parameters-pre-change.json).

const openaiModel = { providerID: "openai", api: { id: "gpt-4.1", npm: "@ai-sdk/openai" } } as never
const azureModel = { providerID: "azure", api: { id: "gpt-4.1", npm: "@ai-sdk/azure" } } as never
const geminiModel = { providerID: "google", api: { id: "gemini-3-pro", npm: "@ai-sdk/google" } } as never

type JsonSchemaNode = {
  anyOf?: JsonSchemaNode[]
  required?: string[]
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
  enum?: unknown[]
  [key: string]: unknown
}

function branches(transformed: JsonSchemaNode): JsonSchemaNode[] {
  expect(Array.isArray(transformed.anyOf)).toBe(true)
  return transformed.anyOf ?? []
}

function branchByAction(transformed: JsonSchemaNode, action: string, withField?: string): JsonSchemaNode[] {
  return branches(transformed).filter((branch) => {
    const actionEnum = branch?.properties?.action?.enum
    if (!Array.isArray(actionEnum) || !actionEnum.includes(action)) return false
    return withField === undefined || branch?.properties?.[withField] !== undefined
  })
}

// Asserts the node carries properties and returns them for traversal.
function record(node: JsonSchemaNode | undefined): Record<string, JsonSchemaNode> {
  expect(node?.properties).toBeDefined()
  return node?.properties ?? {}
}

describe("workflow provider-facing schema", () => {
  test("base wire shape is the 14-branch discriminated union", async () => {
    const schema = ToolJsonSchema.fromSchema(Parameters as never) as JsonSchemaNode
    const evidence = (await Bun.file(
      new URL("./fixtures/workflow-parameters-post-change.json", import.meta.url),
    ).json()) as JsonSchemaNode
    expect(schema.anyOf?.length).toBe(14)
    const flat = JSON.stringify(schema)
    expect(flat).not.toContain('"session_id"')
    expect(flat).not.toContain('"project_id"')
    expect(flat).not.toContain('"skills"')
    expect(Buffer.byteLength(flat, "utf8")).toBe(evidence.schema_bytes as number)
  })

  test("every action stays representable after OpenAI transformation", () => {
    const transformed = ProviderTransform.schema(
      openaiModel,
      ToolJsonSchema.fromSchema(Parameters as never),
    ) as JsonSchemaNode
    for (const action of ["start", "extend", "control", "status", "result", "list", "read", "guide", "validate"]) {
      expect(branchByAction(transformed, action).length).toBeGreaterThan(0)
    }
    // Action fields do not bleed across branches: the status branch carries
    // no spec/operation/cursor fields.
    const status = branchByAction(transformed, "status")[0]
    expect(status.required).toContain("workflow_id")
    expect(Object.keys(status.properties ?? {})).toEqual(["action", "workflow_id"])
  })

  test("OpenAI transformation exposes the nested blocks spec instead of properties: {}", () => {
    const transformed = ProviderTransform.schema(
      openaiModel,
      ToolJsonSchema.fromSchema(Parameters as never),
    ) as JsonSchemaNode
    const startInline = branchByAction(transformed, "start", "spec")[0]
    const config = record(startInline)["spec"]
    expect(record(config)["config"]).toBeDefined()
    const configUnion = record(config)["config"].anyOf ?? []
    const blocksBranch = configUnion.find((branch) => branch.properties?.blocks !== undefined)
    const nodesBranch = configUnion.find((branch) => branch.properties?.nodes !== undefined)
    expect(blocksBranch).toBeDefined()
    expect(nodesBranch).toBeDefined()
    expect(record(blocksBranch)["objective"]).toBeDefined()
    expect(blocksBranch?.required).toEqual(expect.arrayContaining(["name", "objective", "blocks"]))
    expect(nodesBranch?.required).toEqual(expect.arrayContaining(["name", "nodes"]))
    const blockItem = record(blocksBranch)["blocks"]?.items
    expect(Object.keys(record(blockItem))).toEqual(expect.arrayContaining(["id", "kind", "depends_on", "instruction"]))
    expect(Object.keys(record(blockItem))).not.toContain("skills")
    const nodeItem = record(nodesBranch)["nodes"]?.items
    expect(Object.keys(record(nodeItem))).toEqual(
      expect.arrayContaining(["id", "name", "worker_type", "depends_on", "prompt_template"]),
    )
    expect(Object.keys(record(nodeItem))).not.toContain("model")
    expect(Object.keys(record(record(nodesBranch)["node_defaults"]))).not.toContain("model")
    // Exactly-one-source prompt_template: both variants declared.
    const promptTemplate = record(nodeItem)["prompt_template"]
    const promptVariants = promptTemplate?.anyOf ?? []
    expect(promptVariants.some((variant) => variant.properties?.inline !== undefined)).toBe(true)
    expect(promptVariants.some((variant) => variant.properties?.id !== undefined)).toBe(true)
  })

  test("pins the removed Skill-dependent block surface as red evidence", async () => {
    const before = (await Bun.file(
      new URL("./fixtures/workflow-block-skills-pre-internalization.json", import.meta.url),
    ).json()) as { provider_block_item_fields: string[]; compiled_prompt_fragment: string }
    expect(before.provider_block_item_fields).toContain("skills")
    expect(before.compiled_prompt_fragment).toContain("load these relevant skills")

    const schema = JSON.stringify(ToolJsonSchema.fromSchema(Parameters as never))
    expect(schema).not.toContain('"skills"')
  })

  test("Azure transformation keeps the same discriminated union", () => {
    const transformed = ProviderTransform.schema(
      azureModel,
      ToolJsonSchema.fromSchema(Parameters as never),
    ) as JsonSchemaNode
    expect(transformed.anyOf?.length).toBe(14)
    expect(branchByAction(transformed, "start", "spec").length).toBeGreaterThan(0)
    expect(branchByAction(transformed, "validate", "spec_path").length).toBeGreaterThan(0)
  })

  test("Gemini transformation keeps every branch and nested fields", () => {
    const transformed = ProviderTransform.schema(
      geminiModel,
      ToolJsonSchema.fromSchema(Parameters as never),
    ) as JsonSchemaNode
    expect(transformed.anyOf?.length).toBe(14)
    const startInline = branchByAction(transformed, "start", "spec")[0]
    expect(record(record(startInline)["spec"])["config"]).toBeDefined()
    const resultBranch = branchByAction(transformed, "result")[0]
    expect(resultBranch.required).toEqual(expect.arrayContaining(["workflow_id", "node_id"]))
    expect(Object.keys(record(resultBranch))).toEqual(expect.arrayContaining(["cursor", "limit"]))
  })

  test("post-change byte sizes stay at the recorded evidence", async () => {
    const evidence = (await Bun.file(
      new URL("./fixtures/workflow-parameters-post-change.json", import.meta.url),
    ).json()) as {
      schema_bytes: number
      transformed: { openai: { bytes: number }; azure: { bytes: number }; gemini: { bytes: number } }
    }
    const base = JSON.stringify(ToolJsonSchema.fromSchema(Parameters as never))
    expect(Buffer.byteLength(base, "utf8")).toBe(evidence.schema_bytes)
    expect(Buffer.byteLength(JSON.stringify(ProviderTransform.schema(openaiModel, JSON.parse(base))), "utf8")).toBe(
      evidence.transformed.openai.bytes,
    )
    expect(Buffer.byteLength(JSON.stringify(ProviderTransform.schema(azureModel, JSON.parse(base))), "utf8")).toBe(
      evidence.transformed.azure.bytes,
    )
    expect(Buffer.byteLength(JSON.stringify(ProviderTransform.schema(geminiModel, JSON.parse(base))), "utf8")).toBe(
      evidence.transformed.gemini.bytes,
    )
  })
})
