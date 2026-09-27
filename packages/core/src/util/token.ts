export * as Token from "./token"

const CHARS_PER_TOKEN = 4

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

// CJK code points tokenize near one token per character on the openai-compatible relays in use, so the
// English-calibrated length/4 estimate undercounts CJK-dominant text 2-4x. That makes a token reserve built from
// `estimate` systematically undersized: a successful near-cap auxiliary call can then settle above its reserve and
// trip the over-budget paid-admission pause without exceeding any configured limit. `estimateReserve` counts CJK
// code points as one token each and keeps 4 chars/token for the rest; it is ceil-rounded because underestimating a
// reserve is the expensive direction. Reserve/input-gating use this; savings-side estimates stay on `estimate`,
// which understates savings and therefore errs toward fewer paid admissions.
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f], // CJK punctuation
  [0x3040, 0x30ff], // hiragana + katakana
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7af], // hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xffef], // fullwidth forms
  [0x20000, 0x2ffff], // CJK unified ideographs extensions B-F
]

const isCjk = (codePoint: number) => CJK_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)

export const estimateReserve = (input: string) => {
  let cjk = 0
  let other = 0
  for (const ch of input) (isCjk(ch.codePointAt(0) ?? 0) ? cjk++ : other++)
  return Math.max(0, cjk + Math.ceil(other / CHARS_PER_TOKEN))
}
