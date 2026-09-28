/** Explicit, opt-in synthetic acceptance. Never loads or edits user conversations. */
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText } from "ai"
import { Hash } from "@opencode-ai/core/util/hash"
import { ReasoningDistillationPolicy } from "@opencode-ai/core/session/reasoning-distillation"
import { replaceCanonicalReasoning } from "@opencode-ai/core/session/reasoning-distillation/canonical"
import {
  AuxiliaryCallError,
  emptyLifecycleState,
  organizerFingerprintOf,
  runDistillationCycle,
} from "../src/session/reasoning-distillation"

if (!process.env.DISTILLATION_ACCEPTANCE_CONFIG || !process.env.DISTILLATION_ACCEPTANCE_OUTPUT) {
  throw new Error("Set DISTILLATION_ACCEPTANCE_CONFIG and DISTILLATION_ACCEPTANCE_OUTPUT to opt in to live model calls")
}
const config = await Bun.file(process.env.DISTILLATION_ACCEPTANCE_CONFIG).json()
const selected: string = config.small_model
if (typeof selected !== "string") throw new Error("An explicit configured small_model is required")
const separator = selected.indexOf("/")
const providerID = selected.slice(0, separator)
const modelID = selected.slice(separator + 1)
const configured = config.provider?.[providerID]
if (separator < 1 || configured?.npm !== "@ai-sdk/openai-compatible" || !configured.models?.[modelID]) {
  throw new Error("This acceptance harness requires a configured OpenAI-compatible small model")
}
const resolve = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Missing configured endpoint or credential reference")
  return value.replace(/\{env:([^}]+)\}/g, (_, key: string) => {
    const resolved = process.env[key]
    if (!resolved) throw new Error(`Missing environment reference: ${key}`)
    return resolved
  })
}
const baseURL = resolve(configured.options?.baseURL)
const apiKey = resolve(configured.options?.apiKey)
const output = path.resolve(process.env.DISTILLATION_ACCEPTANCE_OUTPUT)
await mkdir(output, { recursive: true })
const noise = "嗯，再想一下。刚才那种说法不够好，重说一遍。只是措辞调整，没有新增事实，也没有采取任何行动。\n"
const fixtures = [
  {
    id: "one-conclusion",
    text:
      noise.repeat(12) +
      "我起初看成3次，核对后明确是5次；3次只是看错，不曾执行。最终决定：测试任务的重试上限设为5次。\n" +
      noise.repeat(8),
    required: ["5"],
    forbidden: ["3次", "看错", "重说一遍"],
    maxClaims: 1,
  },
  {
    id: "deduplicate",
    text: noise.repeat(8) + "仅限测试环境，请求超时为30秒，不得写入生产数据库。\n".repeat(10) + noise.repeat(5),
    required: ["测试", "30", "生产"],
    forbidden: ["重说一遍"],
    maxClaims: 3,
  },
  {
    id: "different-scopes",
    text:
      noise.repeat(10) +
      "约束：alpha服务在测试环境最多重试2次。\n约束：beta服务在生产环境禁止重试，次数为0。\n约束：gamma任务输出必须保存到 /tmp/gamma.json。\n约束：delta流程不能删除原始记录。\n约束：epsilon服务仅允许读取缓存。\n约束：zeta请求超时为45秒。\n" +
      noise.repeat(8),
    required: ["alpha", "2", "beta", "0", "/tmp/gamma.json", "delta", "epsilon", "zeta", "45"],
    forbidden: ["重说一遍"],
    minClaims: 5,
  },
  {
    id: "meaningful-rejection",
    text:
      noise.repeat(10) +
      "我原本倾向方案A，但A不支持当前必须使用的离线协议，因此否决A，最终选择方案B。这个限制仍成立，后续不要重新选A。B尚未执行，不能说已完成。\n" +
      noise.repeat(8),
    required: ["A", "B", "离线", "未"],
    forbidden: ["重说一遍"],
  },
  {
    id: "unresolved",
    text:
      noise.repeat(10) +
      "日志提示可能是网络超时，也可能是锁竞争。目前没有证据排除其中任何一个，尚未确定原因。下一步只读检查超时日志，暂不修改配置。\n" +
      noise.repeat(8),
    required: ["网络", "锁", "只读", "配置"],
    forbidden: ["重说一遍"],
  },
  {
    id: "all-noise",
    text: "嗯……让我想想。再想一下。不，这样说不好，换个说法。算了，刚才只是口头填充。\n".repeat(24),
    required: [],
    forbidden: [],
    maxClaims: 0,
    empty: true,
  },
]

type Stage = {
  role: string
  elapsedMs: number
  headersMs: number
  promptCharacters: number
  answerCharacters: number
  reasoningCharacters: number
  usage?: number
  finishReason: string
  wire: { model?: string; effort?: string; stream?: boolean; maxTokens?: number }
  answer: string
}
const reports: unknown[] = []
let failed = false
for (const fixture of fixtures.filter(
  (item) => !process.env.DISTILLATION_ACCEPTANCE_CASE || item.id === process.env.DISTILLATION_ACCEPTANCE_CASE,
)) {
  const stages: Stage[] = []
  const call = async (role: string, prompt: string) => {
    const started = performance.now()
    let headersMs = 0
    let wire: Stage["wire"] = {}
    const provider = createOpenAICompatible({
      name: providerID,
      baseURL,
      apiKey,
      includeUsage: true,
      fetch: Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
          wire = {
            model: body.model,
            effort: body.reasoning_effort,
            stream: body.stream ?? false,
            maxTokens: body.max_tokens,
          }
          const response = await fetch(url, init)
          headersMs = performance.now() - started
          return response
        },
        { preconnect: fetch.preconnect },
      ),
    })
    try {
      const result = await generateText({
        model: provider(configured.models[modelID].id ?? modelID),
        prompt,
        temperature: 0,
        maxOutputTokens: ReasoningDistillationPolicy.tokens.maxOutputTokens,
        maxRetries: 0,
        providerOptions: { openaiCompatible: { reasoningEffort: "low" } },
        abortSignal: AbortSignal.timeout(30_000),
      })
      const stage = {
        role,
        elapsedMs: performance.now() - started,
        headersMs,
        promptCharacters: prompt.length,
        answerCharacters: result.text.length,
        reasoningCharacters: result.reasoningText?.length ?? 0,
        usage: result.totalUsage.totalTokens,
        finishReason: result.finishReason,
        wire,
        answer: result.text,
      }
      stages.push(stage)
      console.log(JSON.stringify({ case: fixture.id, ...stage, answer: undefined }))
      return stage
    } catch (error) {
      console.log(
        JSON.stringify({
          case: fixture.id,
          role,
          elapsedMs: performance.now() - started,
          error: error instanceof Error ? error.name : "unknown",
        }),
      )
      throw new AuxiliaryCallError({ category: "transport" })
    }
  }
  // Full completion on the same endpoint/effort, rather than comparing first token with a complete JSON result.
  if (fixture.id === "one-conclusion") {
    await call(
      "direct",
      "请对下面的思考文本去重、删除无价值的自我纠错与口头填充，只保留最终有效信息，按实际内容结构化输出。不要固定条数、不要空栏目、不要加入原文之外的内容。\n\n" +
        fixture.text,
    )
  }
  const request = { messages: [{ role: "assistant", reasoning: fixture.text }] }
  const capability = {
    runtime: "opencode-ai-sdk",
    protocol: "openai-compatible",
    providerModelVariant: `${selected}/low`,
    endpointIdentity: Hash.sha256(baseURL),
    adapterVersion: "synthetic-live-acceptance-v1",
    optionsFingerprint: Hash.sha256("low"),
  }
  const auxiliary = (role: string) => async (prompt: string) => {
    const result = await call(role, prompt)
    try {
      return { output: JSON.parse(result.answer) as unknown, usageTokens: result.usage }
    } catch {
      throw new AuxiliaryCallError({ category: "parse", usageTokens: result.usage })
    }
  }
  const started = performance.now()
  const result = await runDistillationCycle(emptyLifecycleState, {
    request,
    identity: { providerID, modelID },
    sessionID: `synthetic-${fixture.id}`,
    purpose: "conversation",
    trigger: "scheduled",
    synchronous: true,
    target: "canonical",
    slots: [
      {
        messageID: "m1",
        partID: "p1",
        bodyPath: [],
        text: fixture.text,
        shape: "interleaved-field",
        signed: false,
        encrypted: false,
        settled: true,
        structureRewritable: true,
      },
    ],
    budget: {
      contextLimit: 1_000_000,
      inputLimit: { kind: "absent" },
      outputReserve: 24_576,
      system: { kind: "none" },
      messages: request.messages,
      tools: [],
      protocolOverheadTokens: 0,
      media: "none",
    },
    calls: [],
    inventoryComplete: true,
    inventoryFingerprint: "synthetic-no-tools",
    capability,
    records: [],
    organizerFingerprint: organizerFingerprintOf({ providerID, modelID, variant: "low" }),
    originalTokens: Math.ceil(fixture.text.length / 4),
    callPropose: auxiliary("propose"),
    callJudge: auxiliary("judge"),
  })
  const elapsedMs = performance.now() - started
  const replacement = result.projection.replacements?.[0]
  const after = replacement?.after
  const proposal = stages.find((stage) => stage.role === "propose")
  const proposed: unknown = proposal ? JSON.parse(proposal.answer) : undefined
  const claimCount =
    proposed && typeof proposed === "object" && "claims" in proposed && Array.isArray(proposed.claims)
      ? proposed.claims.length
      : undefined
  const checks = {
    applied: result.projection.applied,
    adoption:
      replacement !== undefined &&
      replaceCanonicalReasoning({ text: fixture.text, settled: true, distilled: false }, replacement.after)?.text ===
        after,
    required: typeof after === "string" && fixture.required.every((term) => after.includes(term)),
    forbidden: typeof after === "string" && fixture.forbidden.every((term) => !after.includes(term)),
    dynamicCount:
      claimCount !== undefined &&
      (!("maxClaims" in fixture) || claimCount <= fixture.maxClaims!) &&
      (!("minClaims" in fixture) || claimCount >= fixture.minClaims!),
    empty: !("empty" in fixture) || after === "",
    effort: stages.every((stage) => stage.wire.effort === "low"),
  }
  const passed = Object.values(checks).every(Boolean)
  failed ||= !passed
  const report = {
    id: fixture.id,
    model: selected,
    policy: ReasoningDistillationPolicy.version,
    endpointHash: capability.endpointIdentity,
    input: fixture.text,
    elapsedMs,
    checks,
    passed,
    claimCount,
    after,
    attempted: result.attempted,
    skipReason: result.projection.skipReason,
    stages,
  }
  reports.push(report)
  await Bun.write(path.join(output, `${fixture.id}.json`), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      case: fixture.id,
      elapsedMs,
      passed,
      checks,
      after,
      claimCount,
      skipReason: result.projection.skipReason,
    }),
  )
}
await Bun.write(path.join(output, "summary.json"), JSON.stringify({ passed: !failed, reports }, null, 2))
if (failed) process.exitCode = 1
