import { describe, expect, test } from "bun:test"
import { Token } from "../../src/util/token"

describe("Token.estimateReserve", () => {
  test("English text matches the chars-per-token baseline (ceil)", () => {
    expect(Token.estimateReserve("abcdefgh")).toBe(2)
    expect(Token.estimateReserve("abc")).toBe(1)
    expect(Token.estimateReserve("")).toBe(0)
  })

  test("CJK text counts one token per code point, not length/4", () => {
    const text = "反复分析方案与风险"
    expect(Token.estimateReserve(text)).toBe(text.length)
    expect(Token.estimateReserve(text)).toBeGreaterThan(Token.estimate(text))
  })

  test("mixed text sums CJK tokens with ceil(other / 4)", () => {
    expect(Token.estimateReserve("分析abcdefgh")).toBe(2 + 2)
  })

  test("astral CJK code points count once, not twice", () => {
    const text = "\u{20000}\u{20001}"
    expect(Token.estimateReserve(text)).toBe(2)
  })

  test("estimateReserve dominates estimate for CJK and equals it for ASCII", () => {
    const ascii = "a".repeat(100)
    expect(Token.estimateReserve(ascii)).toBe(Token.estimate(ascii))
    const cjk = "评审".repeat(50)
    expect(Token.estimateReserve(cjk)).toBeGreaterThan(Token.estimate(cjk))
  })
})
