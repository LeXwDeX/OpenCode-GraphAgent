import { describe, expect, test } from "bun:test"
import { hookAskInput } from "./hook-ask-input"

describe("hook-forced ask input", () => {
  test("shows a command as is and other tools' full arguments, bounded", () => {
    expect(hookAskInput({ metadata: { hookAsk: true, input: { command: "echo rewritten" } } })).toBe("echo rewritten")
    const edit = hookAskInput({
      metadata: { hookAsk: true, input: { filePath: "src/a.ts", oldString: "a", newString: "b" } },
    })
    expect(edit).toContain('"filePath": "src/a.ts"')
    expect(edit).toContain('"newString": "b"')
    const large = hookAskInput({ metadata: { hookAsk: true, input: { filePath: "a", content: "x".repeat(5_000) } } })
    expect(large.length).toBeLessThan(2_100)
    expect(large).toEndWith("… (truncated)")
  })

  test("ordinary requests keep their patterns", () => {
    expect(hookAskInput({ metadata: { input: { command: "ls" } } })).toBe("")
    expect(hookAskInput({ metadata: { hookAsk: true } })).toBe("")
  })
})
