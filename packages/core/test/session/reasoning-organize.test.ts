import { describe, expect, test } from "bun:test"
import {
  NO_USEFUL_REASONING,
  organizeReasoning,
  ReasoningDistillationPolicy,
  type OrganizeSlot,
} from "../../src/session/reasoning-distillation"
import { Token } from "../../src/util/token"

const slots: OrganizeSlot[] = [
  {
    messageID: "m1",
    partID: "p1",
    text: "重复推测：也许是 A，也许是 B。再看看，可能有消息。检查日志后确认原因，最终决定采用方案 A，并保留回滚步骤。",
  },
  {
    messageID: "m2",
    partID: "p2",
    text: "运行 bun test 失败：权限不足，无法写入 /tmp/cache。尝试更换目录后仍然失败，需要用户授权后再继续执行。",
  },
]

describe("one-call reasoning organizer", () => {
  test("fixtures are above the minimum organizer input size", () => {
    for (const slot of slots)
      expect(Token.estimateReserve(slot.text)).toBeGreaterThanOrEqual(
        ReasoningDistillationPolicy.tokens.minimumInputTokens,
      )
  })

  test("English input requests Chinese prose by default and literal preservation in either format", async () => {
    const text =
      "Run bun test at src/llm.ts; keep maxRetries=0 for v1.0.57 and https://example.com; 2 calls. Then re-check the failing case, compare it with the previous run and record the final decision."
    for (const count of [1, 2]) {
      let calls = 0
      let request: { prompt: string; format: "text" | "json" } | undefined
      const result = await organizeReasoning({
        slots: slots.slice(0, count).map((slot) => ({ ...slot, text })),
        callModel: async ({ prompt, format }) => {
          calls++
          request = { prompt, format }
          return {
            text:
              count === 1
                ? "运行 bun test。"
                : '{"items":[{"slot":0,"text":"运行 bun test。"},{"slot":1,"text":"运行 bun test。"}]}',
          }
        },
      })
      expect(calls).toBe(1)
      expect(result.status).toBe("organized")
      expect(request?.prompt).toContain("整理后的说明文字一律用中文")
      expect(request?.prompt).toContain("文件路径、命令、符号、代码、URL、配置键、版本号和数值逐字保留")
      expect(request?.prompt).toContain(text)
      expect(request?.format).toBe(count === 1 ? "text" : "json")
    }
  })

  test("the English option selects the English instruction for both formats", async () => {
    for (const count of [1, 2]) {
      let prompt = ""
      await organizeReasoning({
        slots: slots.slice(0, count),
        language: "en",
        callModel: async (input) => {
          prompt = input.prompt
          return { text: count === 1 ? "Decided A." : '{"items":[{"slot":0,"text":"A."},{"slot":1,"text":"B."}]}' }
        },
      })
      expect(prompt).toContain("Write all explanatory prose in English")
      expect(prompt).toContain(NO_USEFUL_REASONING)
      expect(prompt).not.toContain("一律用中文")
    }
  })

  test("single slot passes only text and keeps host IDs local", async () => {
    let calls = 0
    const result = await organizeReasoning({
      slots: slots.slice(0, 1),
      callModel: async ({ prompt, format }) => {
        calls++
        expect(format).toBe("text")
        expect(prompt).not.toContain("m1")
        return { text: "最终决定 A。", usageTokens: 12, finishReason: "stop" }
      },
    })
    expect(calls).toBe(1)
    expect(result.status).toBe("organized")
    expect(result.replacements).toEqual([
      { messageID: "m1", partID: "p1", before: slots[0].text, after: "最终决定 A。" },
    ])
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(result.timing.modelMs)
  })

  test("multiple slots use one indexed JSON response", async () => {
    let calls = 0
    const result = await organizeReasoning({
      slots,
      callModel: async ({ format, prompt }) => {
        calls++
        expect(format).toBe("json")
        expect(prompt).not.toContain("m1")
        expect(prompt).toContain("各 slot 独立整理")
        return {
          text: JSON.stringify({
            items: [
              { slot: 1, text: "权限不足。" },
              { slot: 0, text: "最终决定 A。" },
            ],
          }),
        }
      },
    })
    expect(calls).toBe(1)
    expect(result.replacements.map((item) => item.partID)).toEqual(["p1", "p2"])
  })

  test("invalid, duplicate, missing, and truncated batches retain all originals", async () => {
    for (const text of [
      "{}",
      "{",
      '{"items":[{"slot":0,"text":"A"}]}',
      '{"items":[{"slot":0,"text":"A"},{"slot":0,"text":"B"}]}',
    ]) {
      const result = await organizeReasoning({ slots, callModel: async () => ({ text }) })
      expect(result.status).toBe("skipped")
      expect(result.replacements).toEqual([])
    }
    const truncated = await organizeReasoning({
      slots,
      callModel: async () => ({
        text: JSON.stringify({
          items: [
            { slot: 0, text: "A" },
            { slot: 1, text: "B" },
          ],
        }),
        finishReason: "length",
      }),
    })
    expect(truncated.reason).toBe("truncated")
    expect(truncated.replacements).toEqual([])
  })

  test("only the explicit marker clears a slot; an empty body is invalid in either format", async () => {
    const empty = await organizeReasoning({ slots: slots.slice(0, 1), callModel: async () => ({ text: "" }) })
    expect(empty.reason).toBe("invalid-output")
    const noise = await organizeReasoning({
      slots: slots.slice(0, 1),
      callModel: async () => ({ text: NO_USEFUL_REASONING }),
    })
    expect(noise.replacements[0]?.after).toBe("")
    const emptyBatch = await organizeReasoning({
      slots,
      callModel: async () => ({
        text: JSON.stringify({
          items: [
            { slot: 0, text: "" },
            { slot: 1, text: "" },
          ],
        }),
      }),
    })
    expect(emptyBatch.reason).toBe("invalid-output")
    expect(emptyBatch.replacements).toEqual([])
    const batch = await organizeReasoning({
      slots,
      callModel: async () => ({
        text: JSON.stringify({
          items: [
            { slot: 0, text: NO_USEFUL_REASONING },
            { slot: 1, text: "权限不足。" },
          ],
        }),
      }),
    })
    expect(batch.replacements.map((item) => item.after)).toEqual(["", "权限不足。"])
  })

  test("slots below the minimum size are left out without a model call", async () => {
    let calls = 0
    const tiny = { messageID: "m0", partID: "p0", text: "2+2=4。" }
    const skipped = await organizeReasoning({
      slots: [tiny],
      callModel: async () => {
        calls++
        return { text: "4" }
      },
    })
    expect(skipped.reason).toBe("below-minimum")
    expect(calls).toBe(0)
    let format: string | undefined
    const mixed = await organizeReasoning({
      slots: [tiny, slots[0]],
      callModel: async (input) => {
        format = input.format
        return { text: "最终决定 A。" }
      },
    })
    expect(format).toBe("text")
    expect(mixed.replacements.map((item) => item.partID)).toEqual(["p1"])
  })

  test("a replacement that is not smaller than its source is dropped", async () => {
    const longer = slots[0].text + "补充说明。".repeat(10)
    const expanded = await organizeReasoning({
      slots: slots.slice(0, 1),
      callModel: async () => ({ text: longer }),
    })
    expect(expanded.reason).toBe("no-savings")
    expect(expanded.replacements).toEqual([])
    const partial = await organizeReasoning({
      slots,
      callModel: async () => ({
        text: JSON.stringify({
          items: [
            { slot: 0, text: longer },
            { slot: 1, text: "权限不足。" },
          ],
        }),
      }),
    })
    expect(partial.status).toBe("organized")
    expect(partial.replacements.map((item) => item.partID)).toEqual(["p2"])
  })

  test("a failed call leaves the originals alone", async () => {
    const failed = await organizeReasoning({
      slots,
      callModel: async () => {
        throw Error("offline")
      },
    })
    expect(failed.reason).toBe("model-failure")
    expect(failed.replacements).toEqual([])
  })

  test("over-budget input skips before the model call", async () => {
    let calls = 0
    const result = await organizeReasoning({
      slots: [{ messageID: "large", partID: "p", text: "需保留。".repeat(100_000) }],
      callModel: async () => {
        calls++
        return { text: "需保留。" }
      },
    })
    expect(result.reason).toBe("work-limit")
    expect(calls).toBe(0)
  })
})
