import { describe, expect, test } from "bun:test"
import { NO_USEFUL_REASONING, organizeReasoning, type OrganizeSlot } from "../../src/session/reasoning-distillation"

const slots: OrganizeSlot[] = [
  { messageID: "m1", partID: "p1", text: "重复推测。最终决定 A。" },
  { messageID: "m2", partID: "p2", text: "失败：权限不足。" },
]

describe("one-call reasoning organizer", () => {
  test("English input requests Chinese prose and literal preservation in either format", async () => {
    const text = "Run bun test at src/llm.ts; keep maxRetries=0 for v1.0.57 and https://example.com; 2 calls."
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
      { messageID: "m1", partID: "p1", before: slots[0]!.text, after: "最终决定 A。" },
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

  test("empty model response is invalid, explicit all-noise is editable", async () => {
    const empty = await organizeReasoning({ slots: slots.slice(0, 1), callModel: async () => ({ text: "" }) })
    expect(empty.reason).toBe("invalid-output")
    const noise = await organizeReasoning({
      slots: slots.slice(0, 1),
      callModel: async () => ({ text: NO_USEFUL_REASONING }),
    })
    expect(noise.replacements[0]?.after).toBe("")
    const batch = await organizeReasoning({
      slots,
      callModel: async () => ({
        text: JSON.stringify({
          items: [
            { slot: 0, text: "" },
            { slot: 1, text: "权限不足。" },
          ],
        }),
      }),
    })
    expect(batch.replacements[0]?.after).toBe("")
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
