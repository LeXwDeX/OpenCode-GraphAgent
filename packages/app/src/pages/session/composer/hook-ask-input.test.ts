import { describe, expect, test } from "bun:test"
import { hookAskInput } from "./hook-ask-input"

describe("hook-forced ask input", () => {
  test("shows the effective command, path or arguments of a forced ask", () => {
    expect(hookAskInput({ metadata: { hookAsk: true, input: { command: "echo rewritten" } } })).toBe("echo rewritten")
    expect(hookAskInput({ metadata: { hookAsk: true, input: { filePath: "src/a.ts", content: "x" } } })).toBe(
      "src/a.ts",
    )
    expect(hookAskInput({ metadata: { hookAsk: true, input: { query: "q", limit: 2 } } })).toBe(
      '{"query":"q","limit":2}',
    )
  })

  test("ordinary requests keep their patterns", () => {
    expect(hookAskInput({ metadata: { input: { command: "ls" } } })).toBe("")
    expect(hookAskInput({ metadata: { hookAsk: true } })).toBe("")
  })
})
