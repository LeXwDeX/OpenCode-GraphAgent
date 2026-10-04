import { expect, test } from "bun:test"
import { providerRequestHeaders } from "../src/routes/zen/util/provider/headers"
import { anthropicHelper } from "../src/routes/zen/util/provider/anthropic"
import { googleHelper } from "../src/routes/zen/util/provider/google"

test("provider requests retain negotiation but exclude caller credentials", () => {
  for (const [provider, header] of [
    [anthropicHelper({ reqModel: "claude-haiku", providerModel: "claude-haiku" }), "x-api-key"],
    [googleHelper({ reqModel: "gemini", providerModel: "gemini" }), "x-goog-api-key"],
  ] as const) {
    const incoming = new Headers({
      Authorization: "Bearer synthetic-caller-secret",
      Cookie: "session=synthetic-cookie",
      "x-api-key": "another-caller-secret",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "fixture-beta",
      "openai-beta": "responses=v1",
      "content-type": "application/json",
      accept: "text/event-stream",
    })
    const headers = providerRequestHeaders(incoming)
    provider.modifyHeaders(headers, "synthetic-upstream-key", "fixture")
    expect(headers.get(header)).toBe("synthetic-upstream-key")
    expect(headers.get("authorization")).toBeNull()
    expect(headers.get("cookie")).toBeNull()
    expect(headers.get("anthropic-version")).toBe("2023-06-01")
    expect(headers.get("anthropic-beta")).toBe("fixture-beta")
    expect(headers.get("openai-beta")).toBe("responses=v1")
    expect(headers.get("accept")).toBe("text/event-stream")
    expect([...headers.values()].some((x) => x.includes("caller") || x.includes("cookie"))).toBe(false)
  }
})
