import { describe, expect, test } from "bun:test"
import { create } from "@opencode-ai/core/id/id"
import { Identifier } from "./id"

const prefixes = {
  session: "ses",
  message: "msg",
  permission: "per",
  user: "usr",
  part: "prt",
  pty: "pty",
} as const

function decodeTime(id: string): number {
  const start = id.indexOf("_") + 1
  return Number(BigInt("0x" + id.slice(start, start + 12)))
}

describe("Identifier", () => {
  test("every prefix keeps the prefix_underscore_26-char shape", () => {
    for (const prefix of ["session", "message", "permission", "user", "part", "pty"] as const) {
      const ascending = Identifier.ascending(prefix)
      const descending = Identifier.descending(prefix)
      expect(ascending.startsWith(`${prefixes[prefix]}_`)).toBe(true)
      expect(descending.startsWith(`${prefixes[prefix]}_`)).toBe(true)
      for (const id of [ascending, descending]) {
        expect(id).toHaveLength(prefixes[prefix].length + 1 + 26)
        expect(id.slice(prefixes[prefix].length + 1, prefixes[prefix].length + 13)).toMatch(/^[0-9a-f]{12}$/)
      }
    }
  })

  test("ascending ids decode their time prefix back to raw wall-clock ms", () => {
    // The legacy encoding shifted the millisecond value 12 bits and wrapped at
    // 2026-08-14 (issue 271), so under it a live id no longer decodes near
    // Date.now().
    const before = Date.now()
    const id = Identifier.ascending("message")
    const after = Date.now()
    const decoded = decodeTime(id)
    expect(decoded).toBeGreaterThanOrEqual(before - 5000)
    expect(decoded).toBeLessThanOrEqual(after + 5000)
  })

  test("app ids sort consistently with core ids for the same wall-clock", () => {
    const appID = Identifier.ascending("message")
    const coreID = create("msg", "ascending")
    expect(Math.abs(decodeTime(appID) - decodeTime(coreID))).toBeLessThanOrEqual(5000)
  })

  test("same-millisecond bursts stay strictly ascending and unique", () => {
    const ids = Array.from({ length: 20 }, () => Identifier.ascending("message"))
    for (let index = 1; index < ids.length; index++) {
      expect(ids[index - 1] < ids[index]).toBe(true)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("descending ids stay strictly descending and unique", () => {
    const ids = Array.from({ length: 20 }, () => Identifier.descending("session"))
    for (let index = 1; index < ids.length; index++) {
      expect(ids[index - 1] > ids[index]).toBe(true)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("given id passes through when the prefix matches", () => {
    expect(Identifier.ascending("session", "ses_abc123")).toBe("ses_abc123")
    expect(Identifier.descending("message", "msg_abc123")).toBe("msg_abc123")
  })

  test("given id with a wrong prefix throws", () => {
    expect(() => Identifier.ascending("message", "ses_abc123")).toThrow("ID ses_abc123 does not start with msg")
  })
})
