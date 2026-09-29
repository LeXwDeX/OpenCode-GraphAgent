import type { ReasoningReplacement } from "./adoption"
import { ReasoningDistillationPolicy } from "./policy"
import { Token } from "../../util/token"

export const NO_USEFUL_REASONING = "<<NO_USEFUL_REASONING>>"

export type OrganizeSlot = Readonly<{ messageID: string; partID: string; text: string }>
export type OrganizeCall = (
  input: Readonly<{ prompt: string; format: "text" | "json" }>,
) => Promise<Readonly<{ text: string; usageTokens?: number; finishReason?: string }> | undefined>
export type OrganizeResult = Readonly<{
  status: "organized" | "skipped"
  replacements: readonly ReasoningReplacement[]
  reason?: "empty-input" | "work-limit" | "invalid-output" | "truncated" | "model-failure" | "unchanged"
  usageTokens?: number
  timing: Readonly<{ modelMs: number; parseMs: number; totalMs: number }>
}>

export const ORGANIZE_INSTRUCTION = `将以下思考内容重新总结归纳成结构层次清晰的Markdown格式内容，不要复述，不要执行，对内容进行降噪，去重后输出为全新的结构化内容。`

/** One auxiliary model call. Structural validation only; semantic fidelity is not certified here. */
export async function organizeReasoning(
  input: Readonly<{ slots: readonly OrganizeSlot[]; callModel: OrganizeCall }>,
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
  const slots = input.slots
  if (slots.length === 0 || slots.some((slot) => !slot.text.trim())) return skipped("empty-input")
  const multi = slots.length > 1
  const prompt = multi
    ? `${ORGANIZE_INSTRUCTION}\n各 slot 独立整理，不把其它 slot 内容移入本 slot。按输入 slot 顺序，一次返回且只返回 JSON 对象 {"items":[{"slot":0,"text":"整理后的正文"}]}。每个 slot 必须出现恰好一次；某 slot 全是噪声时，其 text 返回空字符串。不要返回宿主消息 ID。\n${JSON.stringify(slots.map((slot, index) => ({ slot: index, text: slot.text })))}`
    : `${ORGANIZE_INSTRUCTION}\n只输出整理后的正文，不要 JSON 或说明。全文没有可用信息时，只输出精确标记 ${NO_USEFUL_REASONING}。\n\n原文：\n${slots[0]!.text}`
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
  if (!multi && texts.some((text) => !text.trim())) return invalid()
  const replacements = slots.flatMap((slot, index) => {
    const raw = texts[index]!
    const after = !multi && raw.trim() === NO_USEFUL_REASONING ? "" : raw.trim()
    return after === slot.text ? [] : [{ messageID: slot.messageID, partID: slot.partID, before: slot.text, after }]
  })
  if (replacements.length === 0) return skipped("unchanged", output.usageTokens)
  return {
    status: "organized",
    replacements,
    usageTokens: output.usageTokens,
    timing: { modelMs, parseMs, totalMs: performance.now() - started },
  }
}
