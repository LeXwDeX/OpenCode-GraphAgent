import { describe, expect, test } from "bun:test"
import { isAllowedAttachmentUrl } from "../../src/cli/cmd/github.shared"

// Issue #442: attachment URLs parsed out of issue/PR markdown are attacker
// controllable. Anything that reaches fetch() carries the GitHub app token,
// so the guard must admit ONLY github.com user-attachment paths over https —
// the handler fetches the validated URL object itself.
describe("isAllowedAttachmentUrl (issue #442)", () => {
  test("admits github.com user-attachment assets and files over https", () => {
    expect(isAllowedAttachmentUrl(URL.parse("https://github.com/user-attachments/assets/abc123"))).toBe(true)
    expect(isAllowedAttachmentUrl(URL.parse("https://github.com/user-attachments/files/21433810/api.json"))).toBe(true)
  })

  test("rejects other hosts, schemes, and paths", () => {
    expect(isAllowedAttachmentUrl(URL.parse("https://attacker.com/pixel.png"))).toBe(false)
    expect(isAllowedAttachmentUrl(URL.parse("https://github.com.evil.io/user-attachments/assets/x"))).toBe(false)
    expect(isAllowedAttachmentUrl(URL.parse("http://github.com/user-attachments/assets/abc123"))).toBe(false)
    expect(isAllowedAttachmentUrl(URL.parse("https://github.com/leak/user-attachments/assets/abc123"))).toBe(false)
    expect(isAllowedAttachmentUrl(URL.parse("https://api.github.com/user-attachments/assets/abc123"))).toBe(false)
  })

  test("rejects null (unparseable URL)", () => {
    expect(isAllowedAttachmentUrl(URL.parse("not a url ::"))).toBe(false)
  })
})
