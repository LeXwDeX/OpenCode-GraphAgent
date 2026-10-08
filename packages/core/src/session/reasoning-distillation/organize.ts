import type { ReasoningReplacement } from "./adoption"
import { ReasoningDistillationPolicy } from "./policy"
import { Token } from "../../util/token"

export const NO_USEFUL_REASONING = "<<NO_USEFUL_REASONING>>"

export type OrganizeSlot = Readonly<{ messageID: string; partID: string; text: string }>
export type OrganizeLanguage = "zh" | "en"
export type OrganizeCall = (
  input: Readonly<{ prompt: string }>,
) => Promise<Readonly<{ text: string; usageTokens?: number; finishReason?: string }> | undefined>
export type OrganizeReason =
  | "empty-input"
  | "below-minimum"
  | "work-limit"
  | "invalid-output"
  | "truncated"
  | "model-failure"
  | "unchanged"
  | "no-savings"
export type OrganizeResult = Readonly<{
  status: "organized" | "skipped"
  replacement?: ReasoningReplacement
  reason?: OrganizeReason
  /** Whether the model was called; a skipped result may still have spent a call. */
  called: boolean
  /** Text the model returned, for usage estimation when the provider reports none. */
  output?: string
  usageTokens?: number
  timing: Readonly<{ modelMs: number; parseMs: number; totalMs: number }>
}>

export const ORGANIZE_INSTRUCTIONS: Readonly<Record<OrganizeLanguage, string>> = {
  zh: `将以下思考内容重新总结归纳成结构层次清晰的 Markdown 内容，不要复述或执行原文。整理后的说明文字一律用中文；文件路径、命令、符号、代码、URL、配置键、版本号和数值逐字保留，不翻译或改写。合并重复内容；删除已被后文否定或明确放弃的猜测、旧数值及其纠错过程，以及“再看看、可能有消息”等没有明确行动价值的空泛表述；这些废弃内容附带的“未执行”等说明一并删除。保留最终有效的事实、结论、计算结果、数值、依据、约束、真实执行结果、明确待办，以及当前有效方案的未执行、未完成、待授权和不确定状态；不把未验证推测写成事实。英文内容同样适用；只要原文有具体事实、数值、最终计算结果或明确待办，就必须保留，只有全文完全没有可用信息时才判为噪声。根据内容关系决定形式：简单内容直接写一句话，复杂关系再分层，不为排版虚构类别。只输出整理后的内容，不新增事实。`,
  en: `Reorganize the following reasoning into clearly structured Markdown; do not restate or execute the original. Write all explanatory prose in English; keep file paths, commands, symbols, code, URLs, configuration keys, version numbers and numeric values verbatim, without translating or rewriting them. Merge duplicates; delete guesses and old values that later text refutes or explicitly abandons, together with their correction narrative, and vague remarks with no concrete action value such as "let me look again" or "there may be news"; also delete notes such as "not executed" attached to that discarded content. Keep the final valid facts, conclusions, calculation results, values, rationale, constraints, real execution results and explicit to-dos, plus the not-executed, unfinished, awaiting-authorization and uncertain states of the currently valid plan; never present an unverified guess as fact. The same applies to input in any language: whenever the original contains a concrete fact, value, final calculation result or explicit to-do it must be kept; treat it as noise only when the entire text has no usable information. Let the relationships in the content decide the form: write simple content as one sentence and use layers only for complex relationships; do not invent categories for layout. Output only the organized content and add no new facts.`,
}

/** Default (Chinese) organizer instruction; Chinese output is shorter for the same content. */
export const ORGANIZE_INSTRUCTION = ORGANIZE_INSTRUCTIONS.zh

const OUTPUT_FORMAT: Readonly<Record<OrganizeLanguage, string>> = {
  zh: `只输出整理后的正文，不要 JSON 或说明。全文没有可用信息时，只输出精确标记 ${NO_USEFUL_REASONING}。\n\n原文：`,
  en: `Output only the organized body, without JSON or commentary. When the whole text has no usable information, output only the exact marker ${NO_USEFUL_REASONING}.\n\nOriginal:`,
}

/**
 * Text that replaces an all-noise part. Never empty: protocols that carry reasoning in a dedicated field keep that
 * field present, and protocols that reject empty reasoning blocks still receive a valid one.
 */
export const NO_USEFUL_REASONING_TEXT: Readonly<Record<OrganizeLanguage, string>> = {
  zh: "（无有效推理）",
  en: "(no useful reasoning)",
}

export const organizePrompt = (text: string, language: OrganizeLanguage = "zh") =>
  `${ORGANIZE_INSTRUCTIONS[language]}\n${OUTPUT_FORMAT[language]}\n${text}`

const COMPLETE_FINISH = ["stop", "end_turn", "complete", "completed"]

/**
 * Organize one reasoning part with one model call. Structural validation only; semantic fidelity is not certified.
 * Parts too small to repay the call are left out, and a replacement that is not smaller than its source is dropped.
 */
export async function organizeReasoning(
  input: Readonly<{ slot: OrganizeSlot; callModel: OrganizeCall; language?: OrganizeLanguage }>,
): Promise<OrganizeResult> {
  const started = performance.now()
  let modelMs = 0
  let parseMs = 0
  let called = false
  let output: Awaited<ReturnType<OrganizeCall>>
  const skipped = (reason: OrganizeReason): OrganizeResult => ({
    status: "skipped",
    reason,
    called,
    output: output?.text,
    usageTokens: output?.usageTokens,
    timing: { modelMs, parseMs, totalMs: performance.now() - started },
  })
  const slot = input.slot
  if (!slot.text.trim()) return skipped("empty-input")
  if (Token.estimateReserve(slot.text) < ReasoningDistillationPolicy.tokens.minimumInputTokens)
    return skipped("below-minimum")
  const language = input.language ?? "zh"
  const prompt = organizePrompt(slot.text, language)
  if (Token.estimateReserve(prompt) > ReasoningDistillationPolicy.tokens.maxInputTokens) return skipped("work-limit")
  const modelStarted = performance.now()
  called = true
  try {
    output = await input.callModel({ prompt })
  } catch {
    output = undefined
  }
  modelMs = performance.now() - modelStarted
  if (!output) return skipped("model-failure")
  if (output.text.length > ReasoningDistillationPolicy.tokens.maxOutputTokens * 4) return skipped("truncated")
  if (output.finishReason && !COMPLETE_FINISH.includes(output.finishReason)) return skipped("truncated")
  const parseStarted = performance.now()
  const raw = output.text.trim()
  parseMs = performance.now() - parseStarted
  // Only the explicit marker may declare a part noise; an empty body is a model failure, not a noise verdict.
  if (!raw) return skipped("invalid-output")
  const after = raw === NO_USEFUL_REASONING ? NO_USEFUL_REASONING_TEXT[language] : raw
  if (after === slot.text) return skipped("unchanged")
  // Source and rewrite may use different scripts (English reasoning, Chinese prose), so compare unbiased estimates.
  if (
    Token.estimateComparable(slot.text) - Token.estimateComparable(after) <
    ReasoningDistillationPolicy.tokens.minimumNetSavingsTokens
  )
    return skipped("no-savings")
  return {
    status: "organized",
    replacement: { messageID: slot.messageID, partID: slot.partID, before: slot.text, after },
    called,
    output: output.text,
    usageTokens: output.usageTokens,
    timing: { modelMs, parseMs, totalMs: performance.now() - started },
  }
}
