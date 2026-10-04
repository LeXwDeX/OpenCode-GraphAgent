import { expect, test } from "bun:test"
import type { APIEvent } from "@solidjs/start/server"
import { Share } from "../../src/core/share"
import { GET } from "../../src/routes/api/[...path]"

test("revocable share response cannot be stored in an HTTP cache", async () => {
  const share = await Share.create({ sessionID: `test_${crypto.randomUUID()}` })
  const event = { request: new Request(`https://fixture.invalid/api/share/${share.id}/data`) } as APIEvent
  const response = await GET(event)
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  await Share.remove(share)
  expect((await GET(event)).status).not.toBe(200)
})
