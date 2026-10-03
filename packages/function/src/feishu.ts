import { timingSafeEqual } from "node:crypto"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function authenticated(body: Record<string, unknown>, expected: string | undefined) {
  if (!expected || body.encrypt !== undefined) return false
  if (body.schema !== undefined && body.schema !== "2.0") return false
  const token = body.schema === "2.0" ? (record(body.header) ? body.header.token : undefined) : body.token
  if (typeof token !== "string" || !token) return false
  const suppliedBytes = Buffer.from(token)
  const expectedBytes = Buffer.from(expected)
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
}

export async function feishuResponse(
  body: unknown,
  verificationToken: string | undefined,
  send: (message: string) => Promise<boolean>,
) {
  if (!record(body)) return Response.json({ error: "Invalid event" }, { status: 400 })
  if (!authenticated(body, verificationToken)) return Response.json({ error: "Unauthorized" }, { status: 401 })
  if (typeof body.challenge === "string" && body.challenge) return Response.json({ challenge: body.challenge })

  const event = record(body.event) ? body.event : undefined
  const input = event && record(event.message) ? event.message : undefined
  const content = input?.content
  let text = typeof content === "string" ? content : ""
  if (text.trim().startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return Response.json({ error: "Invalid message content" }, { status: 400 })
    }
    text = record(parsed) && typeof parsed.text === "string" ? parsed.text : ""
  }

  let message = text.trim().replace(/^@_user_\d+\s*/, "")
  message = message.replace(/^aiden,?\s*/i, "<@759257817772851260> ")
  if (!message) return Response.json({ ok: true })
  const threadId = input?.root_id || input?.message_id
  if (typeof threadId === "string" && threadId) message = `${message} [${threadId}]`

  try {
    if (await send(message)) return Response.json({ ok: true })
  } catch {
    // Return only a stable public error; never log the token-bearing event.
  }
  return Response.json({ error: "Discord bot message failed" }, { status: 502 })
}
