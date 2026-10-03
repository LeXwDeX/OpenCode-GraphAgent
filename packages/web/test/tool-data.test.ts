import { describe, expect, test } from "bun:test"
import { count, diagnosticsForFile, isRecord, text, todos } from "../src/components/share/tool-data"

describe("shared tool payloads", () => {
  test("keeps text and counts typed while rejecting malformed JSON values", () => {
    expect(text("src/file.ts")).toBe("src/file.ts")
    for (const value of [null, 12, {}, ["path"]]) expect(text(value)).toBeUndefined()
    expect(count(3)).toBe(3)
    for (const value of ["3", null, -1, NaN, Infinity]) expect(count(value)).toBe(0)
    expect(isRecord({ city: "Paris" })).toBe(true)
    expect(isRecord([])).toBe(false)
  })

  test("renders valid error diagnostics without trusting malformed ranges", () => {
    const valid = { severity: 1, message: "Missing import", range: { start: { line: 2, character: 4 } } }
    const payload = {
      "src/file.ts": [
        valid,
        null,
        { ...valid, range: {} },
        { ...valid, severity: 2 },
        { ...valid, range: { start: { line: -1, character: 0 } } },
        { ...valid, message: {} },
      ],
    }
    expect(diagnosticsForFile(payload, "src/file.ts")).toEqual([{ line: 3, column: 5, message: "Missing import" }])
    expect(diagnosticsForFile(payload, "other.ts")).toEqual([])
    expect(diagnosticsForFile({ "src/file.ts": {} }, "src/file.ts")).toEqual([])
    expect(diagnosticsForFile(null, "src/file.ts")).toEqual([])
  })

  test("filters malformed todo entries without crashing the share page", () => {
    const valid = { id: "1", content: "Read code", status: "in_progress" as const }
    expect(todos([valid, null, { ...valid, content: {} }, { ...valid, status: "unknown" }])).toEqual([valid])
    expect(todos({})).toEqual([])
  })
})
