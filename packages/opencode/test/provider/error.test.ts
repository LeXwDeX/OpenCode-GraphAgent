import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { commandName } from "../../src/command-name"
import { parseAPICallError } from "../../src/provider/error"

describe("provider.error gateway", () => {
  test("401 HTML gateway response hint uses dynamic command name", () => {
    const parsed = parseAPICallError({
      providerID: "anthropic" as never,
      error: new APICallError({
        message: "Unauthorized",
        url: "https://gateway.example.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 401,
        responseBody: "<!doctype html><html><body>Blocked</body></html>",
        isRetryable: false,
      }),
    })
    expect(parsed.type).toBe("api_error")
    expect(parsed.message).toContain(`\`${commandName()} auth login <your provider URL>\``)
    expect(parsed.message).not.toContain("opencode auth login")
  })
})
