import { describe, expect, test } from "bun:test"
import { extractImageAttachments } from "../../src/acp/tool"

describe("data URL image attachment parsing", () => {
  test("rejects adversarial unterminated parameter runs quickly", () => {
    // Kept first in the file so an unbounded rewrite gets probed cold. The old
    // nested-quantifier regex burned its entire engine backtracking budget on
    // this input (~535ms in bun's JSC before bailing to no-match; unbounded in
    // engines without a budget); any linear or bounded rewrite rejects it in
    // microseconds.
    const url = "data:image/png" + ";a".repeat(34)
    const start = performance.now()
    expect(extractImageAttachments([{ url }])).toEqual([])
    expect(performance.now() - start).toBeLessThan(100)
  })

  test("extracts image data URLs with extra parameters before base64", () => {
    expect(extractImageAttachments([{ url: "data:image/png;foo=bar;base64,QUJD" }])).toEqual([
      { mimeType: "image/png", data: "QUJD" },
    ])
    expect(extractImageAttachments([{ url: "data:image/png;charset=utf-8;foo=bar;base64,QUJD" }])).toEqual([
      { mimeType: "image/png", data: "QUJD" },
    ])
  })

  test("rejects data URLs whose payload is not base64", () => {
    expect(extractImageAttachments([{ mime: "image/png", url: "data:image/png,raw-payload" }])).toEqual([])
    expect(extractImageAttachments([{ mime: "image/png", url: "data:image/png;base64" }])).toEqual([])
  })

  test("rejects non-image data URL mime types even when the attachment mime claims image", () => {
    expect(extractImageAttachments([{ mime: "image/png", url: "data:text/plain;base64,QUJD" }])).toEqual([])
    expect(extractImageAttachments([{ mime: "image/png", url: "data:;base64,QUJD" }])).toEqual([])
  })

  test("does not extract attachments without a data URL regardless of mime", () => {
    expect(extractImageAttachments([{ mime: "image/png" }])).toEqual([])
    expect(extractImageAttachments([{ mime: "text/plain" }])).toEqual([])
  })
})
