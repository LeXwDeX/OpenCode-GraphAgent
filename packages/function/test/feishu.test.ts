import { describe, expect, test } from "bun:test"
import { feishuResponse } from "../src/feishu"

const verificationToken = "synthetic-verification-token"
const event = { message: { content: '{"text":"hello"}', message_id: "msg_test" } }

describe("Feishu source authentication", () => {
  test("missing, incorrect, empty, mixed-version, and encrypted tokens never send messages", async () => {
    let calls = 0
    const send = async () => {
      calls++
      return true
    }
    const bodies = [
      { event },
      { token: "", event },
      { token: "wrong", event },
      { schema: "2.0", token: verificationToken, header: { token: "wrong" }, event },
      { schema: "2.0", token: verificationToken, event },
      { schema: "unknown", token: verificationToken, event },
      { token: verificationToken, encrypt: "unsupported", event },
    ]
    for (const body of bodies) expect((await feishuResponse(body, verificationToken, send)).status).toBe(401)
    for (const config of [undefined, ""])
      expect((await feishuResponse({ token: verificationToken, event }, config, send)).status).toBe(401)
    expect(calls).toBe(0)
  })

  test("authenticated legacy and schema v2 events send the expected message", async () => {
    const sent: string[] = []
    const send = async (message: string) => {
      sent.push(message)
      return true
    }
    for (const body of [
      { token: verificationToken, event },
      { schema: "2.0", header: { token: verificationToken }, event },
    ])
      expect((await feishuResponse(body, verificationToken, send)).status).toBe(200)
    expect(sent).toEqual(["hello [msg_test]", "hello [msg_test]"])
  })

  test("challenges require authentication and never contact Discord", async () => {
    let calls = 0
    const send = async () => {
      calls++
      return true
    }
    expect((await feishuResponse({ challenge: "test" }, verificationToken, send)).status).toBe(401)
    const response = await feishuResponse({ token: verificationToken, challenge: "test" }, verificationToken, send)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(JSON.stringify({ challenge: "test" }))
    expect(calls).toBe(0)
  })

  test("malformed events and content do not contact Discord", async () => {
    let calls = 0
    const send = async () => {
      calls++
      return true
    }
    expect((await feishuResponse(undefined, verificationToken, send)).status).toBe(400)
    expect(
      (
        await feishuResponse(
          { token: verificationToken, event: { message: { content: "{invalid" } } },
          verificationToken,
          send,
        )
      ).status,
    ).toBe(400)
    expect(calls).toBe(0)
  })

  test("Discord failures return a stable error without exposing event credentials", async () => {
    const response = await feishuResponse({ token: verificationToken, event }, verificationToken, async () => {
      throw new Error("synthetic failure")
    })
    expect(response.status).toBe(502)
    expect(await response.text()).toBe(JSON.stringify({ error: "Discord bot message failed" }))
  })
})
