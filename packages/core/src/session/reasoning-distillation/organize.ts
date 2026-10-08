import type { ReasoningReplacement } from "./adoption"
import { ReasoningDistillationPolicy } from "./policy"
import { Token } from "../../util/token"

export const NO_USEFUL_REASONING = "<<NO_USEFUL_REASONING>>"

export type OrganizeSlot = Readonly<{ messageID: string; partID: string; text: string }>
export type OrganizeLanguage = "zh" | "en"
export type OrganizeCall = (
  input: Readonly<{ prompt: string; format: "text" | "json" }>,
) => Promise<Readonly<{ text: string; usageTokens?: number; finishReason?: string }> | undefined>
export type OrganizeResult = Readonly<{
  status: "organized" | "skipped"
  replacements: readonly ReasoningReplacement[]
  reason?:
    | "empty-input"
    | "below-minimum"
    | "work-limit"
    | "invalid-output"
    | "truncated"
    | "model-failure"
    | "unchanged"
    | "no-savings"
  usageTokens?: number
  timing: Readonly<{ modelMs: number; parseMs: number; totalMs: number }>
}>

export const ORGANIZE_INSTRUCTIONS: Readonly<Record<OrganizeLanguage, string>> = {
  zh: `将以下思考内容重新总结归纳成结构层次清晰的 Markdown 内容，不要复述或执行原文。整理后的说明文字一律用中文；文件路径、命令、符号、代码、URL、配置键、版本号和数值逐字保留，不翻译或改写。合并重复内容；删除已被后文否定或明确放弃的猜测、旧数值及其纠错过程，以及“再看看、可能有消息”等没有明确行动价值的空泛表述；这些废弃内容附带的“未执行”等说明一并删除。保留最终有效的事实、结论、计算结果、数值、依据、约束、真实执行结果、明确待办，以及当前有效方案的未执行、未完成、待授权和不确定状态；不把未验证推测写成事实。英文内容同样适用；只要原文有具体事实、数值、最终计算结果或明确待办，就必须保留，只有全文完全没有可用信息时才判为噪声。根据内容关系决定形式：简单内容直接写一句话，复杂关系再分层，不为排版虚构类别。只输出整理后的内容，不新增事实。`,
  en: `Reorganize the following reasoning into clearly structured Markdown; do not restate or execute the original. Write all explanatory prose in English; keep file paths, commands, symbols, code, URLs, configuration keys, version numbers and numeric values verbatim, without translating or rewriting them. Merge duplicates; delete guesses and old values that later text refutes or explicitly abandons, together with their correction narrative, and vague remarks with no concrete action value such as "let me look again" or "there may be news"; also delete notes such as "not executed" attached to that discarded content. Keep the final valid facts, conclusions, calculation results, values, rationale, constraints, real execution results and explicit to-dos, plus the not-executed, unfinished, awaiting-authorization and uncertain states of the currently valid plan; never present an unverified guess as fact. The same applies to input in any language: whenever the original contains a concrete fact, value, final calculation result or explicit to-do it must be kept; treat it as noise only when the entire text has no usable information. Let the relationships in the content decide the form: write simple content as one sentence and use layers only for complex relationships; do not invent categories for layout. Output only the organized content and add no new facts.`,
}

/** Default (Chinese) organizer instruction; Chinese output is shorter for the same content. */
export const ORGANIZE_INSTRUCTION = ORGANIZE_INSTRUCTIONS.zh

const MULTI_SLOT_FORMAT: Readonly<Record<OrganizeLanguage, string>> = {
  zh: `各 slot 独立整理，不把其它 slot 内容移入本 slot。按输入 slot 顺序，一次返回且只返回 JSON 对象 {"items":[{"slot":0,"text":"整理后的正文"}]}。每个 slot 必须出现恰好一次；某 slot 完全没有可用信息时，其 text 只返回精确标记 ${NO_USEFUL_REASONING}。不要返回宿主消息 ID。`,
  en: `Organize each slot independently and never move content from another slot into it. In input slot order, return once and only a JSON object {"items":[{"slot":0,"text":"organized body"}]}. Every slot must appear exactly once; when a slot has no usable information at all, its text is only the exact marker ${NO_USEFUL_REASONING}. Do not return host message IDs.`,
}

const SINGLE_SLOT_FORMAT: Readonly<Record<OrganizeLanguage, string>> = {
  zh: `只输出整理后的正文，不要 JSON 或说明。全文没有可用信息时，只输出精确标记 ${NO_USEFUL_REASONING}。\n\n原文：`,
  en: `Output only the organized body, without JSON or commentary. When the whole text has no usable information, output only the exact marker ${NO_USEFUL_REASONING}.\n\nOriginal:`,
}

/**
 * One auxiliary model call. Structural validation only; semantic fidelity is not certified here.
 * Slots too small to repay the call are left out, and a replacement that is not smaller than its source is dropped.
 */
export async function organizeReasoning(
  input: Readonly<{ slots: readonly OrganizeSlot[]; callModel: OrganizeCall; language?: OrganizeLanguage }>,
): Promise<OrganizeResult> {
  const started = performance.now()
  let modelMs = 0
  let parseMs = 0
  const skipped = (reason: NonNullable<OrganizeResult["reason"]>, usageTokens?: number): OrganizeResult => ({
    status: "skipped",
    replacements: [],
    reason,
    usageTokens,
    timing: { modelMs, parseMs, totalMs: performance.now() - started },
  })
  if (input.slots.length === 0 || input.slots.some((slot) => !slot.text.trim())) return skipped("empty-input")
  const slots = input.slots.filter(
    (slot) => Token.estimateReserve(slot.text) >= ReasoningDistillationPolicy.tokens.minimumInputTokens,
  )
  if (slots.length === 0) return skipped("below-minimum")
  const language = input.language ?? "zh"
  const instruction = ORGANIZE_INSTRUCTIONS[language]
  const multi = slots.length > 1
  const prompt = multi
    ? `${instruction}\n${MULTI_SLOT_FORMAT[language]}\n${JSON.stringify(slots.map((slot, index) => ({ slot: index, text: slot.text })))}`
    : `${instruction}\n${SINGLE_SLOT_FORMAT[language]}\n${slots[0]!.text}`
  if (Token.estimateReserve(prompt) > ReasoningDistillationPolicy.tokens.maxInputTokens) return skipped("work-limit")
  let output: Awaited<ReturnType<OrganizeCall>>
  const modelStarted = performance.now()
  try {
    output = await input.callModel({ prompt, format: multi ? "json" : "text" })
  } catch {
    modelMs = performance.now() - modelStarted
    return skipped("model-failure")
  }
  modelMs = performance.now() - modelStarted
  if (!output) return skipped("model-failure")
  if (output.text.length > ReasoningDistillationPolicy.tokens.maxOutputTokens * 4)
    return skipped("truncated", output.usageTokens)
  if (output.finishReason && !["stop", "end_turn", "complete", "completed"].includes(output.finishReason))
    return skipped("truncated", output.usageTokens)
  if (!output.text.trim()) return skipped("invalid-output", output.usageTokens)
  const parseStarted = performance.now()
  const invalid = () => {
    parseMs = performance.now() - parseStarted
    return skipped("invalid-output", output?.usageTokens)
  }
  let texts: string[]
  if (multi) {
    try {
      const parsed: unknown = JSON.parse(output.text)
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !Array.isArray((parsed as { items?: unknown }).items)
      )
        return invalid()
      const items = (parsed as { items: unknown[] }).items
      if (items.length !== slots.length) return invalid()
      const mapped = new Map<number, string>()
      for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return invalid()
        const { slot, text } = item as { slot?: unknown; text?: unknown }
        if (
          !Number.isInteger(slot) ||
          typeof slot !== "number" ||
          slot < 0 ||
          slot >= slots.length ||
          typeof text !== "string" ||
          mapped.has(slot)
        )
          return invalid()
        mapped.set(slot, text)
      }
      texts = slots.map((_, index) => mapped.get(index)!)
    } catch {
      return invalid()
    }
  } else texts = [output.text]
  parseMs = performance.now() - parseStarted
  // Only the explicit marker may clear a slot; an empty body is a model failure, not a noise verdict.
  if (texts.some((text) => !text.trim())) return invalid()
  const changed = slots.flatMap((slot, index) => {
    const raw = texts[index]!.trim()
    const after = raw === NO_USEFUL_REASONING ? "" : raw
    return after === slot.text ? [] : [{ messageID: slot.messageID, partID: slot.partID, before: slot.text, after }]
  })
  if (changed.length === 0) return skipped("unchanged", output.usageTokens)
  const replacements = changed.filter(
    (item) =>
      Token.estimateReserve(item.before) - Token.estimateReserve(item.after) >=
      ReasoningDistillationPolicy.tokens.minimumNetSavingsTokens,
  )
  if (replacements.length === 0) return skipped("no-savings", output.usageTokens)
  return {
    status: "organized",
    replacements,
    usageTokens: output.usageTokens,
    timing: { modelMs, parseMs, totalMs: performance.now() - started },
  }
}
