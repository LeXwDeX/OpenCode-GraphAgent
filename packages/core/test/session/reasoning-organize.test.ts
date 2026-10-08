import { describe, expect, test } from "bun:test"
import {
  NO_USEFUL_REASONING,
  NO_USEFUL_REASONING_TEXT,
  organizeReasoning,
  ReasoningDistillationPolicy,
  type OrganizeSlot,
} from "../../src/session/reasoning-distillation"
import { Token } from "../../src/util/token"

const slot: OrganizeSlot = {
  messageID: "m1",
  partID: "p1",
  text: "重复推测：也许是 A，也许是 B。再看看，可能有消息。检查日志后确认原因，最终决定采用方案 A，并保留回滚步骤。",
}

describe("single-part reasoning organizer", () => {
  test("the fixture is above the minimum organizer input size", () => {
    expect(Token.estimateReserve(slot.text)).toBeGreaterThanOrEqual(
      ReasoningDistillationPolicy.tokens.minimumInputTokens,
    )
  })

  test("requests Chinese prose by default with literal preservation, sending only the text", async () => {
    const text =
      "Run bun test at src/llm.ts; keep maxRetries=0 for v1.0.57 and https://example.com; 2 calls. Then re-check the failing case, compare it with the previous run and record the final decision."
    let prompt = ""
    const result = await organizeReasoning({
      slot: { ...slot, text },
      callModel: async (input) => {
        prompt = input.prompt
        return { text: "运行 bun test。", usageTokens: 12, finishReason: "stop" }
      },
    })
    expect(result.status).toBe("organized")
    expect(result.called).toBe(true)
    expect(result.usageTokens).toBe(12)
    expect(prompt).toContain("整理后的说明文字一律用中文")
    expect(prompt).toContain("文件路径、命令、符号、代码、URL、配置键、版本号和数值逐字保留")
    expect(prompt).toContain(text)
    expect(prompt).not.toContain("m1")
    expect(prompt).not.toContain('"items"')
    expect(result.replacement).toEqual({ messageID: "m1", partID: "p1", before: text, after: "运行 bun test。" })
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(result.timing.modelMs)
  })

  test("the English option selects the English instruction", async () => {
    let prompt = ""
    await organizeReasoning({
      slot,
      language: "en",
      callModel: async (input) => {
        prompt = input.prompt
        return { text: "Decided A." }
      },
    })
    expect(prompt).toContain("Write all explanatory prose in English")
    expect(prompt).toContain(NO_USEFUL_REASONING)
    expect(prompt).not.toContain("一律用中文")
  })

  test("the explicit marker becomes a non-empty placeholder; an empty body is invalid", async () => {
    for (const language of ["zh", "en"] as const) {
      const noise = await organizeReasoning({
        slot,
        language,
        callModel: async () => ({ text: ` ${NO_USEFUL_REASONING}\n` }),
      })
      expect(noise.status).toBe("organized")
      expect(noise.replacement?.after).toBe(NO_USEFUL_REASONING_TEXT[language])
      expect(noise.replacement?.after.length).toBeGreaterThan(0)
    }
    const empty = await organizeReasoning({ slot, callModel: async () => ({ text: " \n" }) })
    expect(empty).toMatchObject({ status: "skipped", reason: "invalid-output", called: true })
  })

  test("truncated, oversized and failed calls retain the original", async () => {
    const truncated = await organizeReasoning({
      slot,
      callModel: async () => ({ text: "方案 A。", finishReason: "length" }),
    })
    expect(truncated).toMatchObject({ status: "skipped", reason: "truncated", output: "方案 A。" })
    const oversized = await organizeReasoning({
      slot,
      callModel: async () => ({ text: "x".repeat(ReasoningDistillationPolicy.tokens.maxOutputTokens * 4 + 1) }),
    })
    expect(oversized.reason).toBe("truncated")
    const failed = await organizeReasoning({
      slot,
      callModel: async () => {
        throw new Error("network")
      },
    })
    expect(failed).toMatchObject({ status: "skipped", reason: "model-failure", called: true })
    expect(failed.output).toBeUndefined()
    const missing = await organizeReasoning({ slot, callModel: async () => undefined })
    expect(missing).toMatchObject({ status: "skipped", reason: "model-failure", called: true })
  })

  test("parts below the minimum size or above the input limit skip without a model call", async () => {
    let calls = 0
    const callModel = async () => {
      calls++
      return { text: "短。" }
    }
    const small = await organizeReasoning({ slot: { ...slot, text: "短。" }, callModel })
    expect(small).toMatchObject({ status: "skipped", reason: "below-minimum", called: false })
    const large = await organizeReasoning({
      slot: { ...slot, text: "长".repeat(ReasoningDistillationPolicy.tokens.maxInputTokens + 1) },
      callModel,
    })
    expect(large).toMatchObject({ status: "skipped", reason: "work-limit", called: false })
    const blank = await organizeReasoning({ slot: { ...slot, text: "  " }, callModel })
    expect(blank.reason).toBe("empty-input")
    expect(calls).toBe(0)
  })

  test("a replacement that is unchanged or not smaller than its source is dropped", async () => {
    const unchanged = await organizeReasoning({ slot, callModel: async () => ({ text: slot.text }) })
    expect(unchanged.reason).toBe("unchanged")
    const longer = await organizeReasoning({ slot, callModel: async () => ({ text: `${slot.text}补充。` }) })
    expect(longer).toMatchObject({ status: "skipped", reason: "no-savings" })
    expect(longer.replacement).toBeUndefined()
  })
})
