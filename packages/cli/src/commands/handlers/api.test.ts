import { describe, expect, test } from "bun:test"
import { fetchRequest, rawRequest, requestURL, resolveOperation } from "./api"

describe("api request resolution", () => {
  test("resolves an operation ID with path and query parameters", () => {
    expect(
      resolveOperation(
        {
          paths: {
            "/api/session/{sessionID}": {
              get: { operationId: "v2.session.get" },
            },
          },
        },
        "v2.session.get",
        { sessionID: "ses/a", workspace: "work" },
      ),
    ).toEqual({ method: "GET", path: "/api/session/ses%2Fa?workspace=work" })
  })

  test("rejects a missing path parameter", () => {
    expect(() =>
      resolveOperation(
        { paths: { "/api/session/{sessionID}": { get: { operationId: "v2.session.get" } } } },
        "v2.session.get",
        {},
      ),
    ).toThrow("Missing path parameter: sessionID")
  })

  test("resolves curl-like method and path input", () => {
    expect(rawRequest(["post", "/api/foo"])).toEqual({ method: "POST", path: "/api/foo" })
    expect(rawRequest(["v2.session.list"])).toBeUndefined()
  })

  test("rejects protocol-relative and backslash paths", () => {
    expect(rawRequest(["get", "//fixture.invalid/api"])).toBeUndefined()
    expect(rawRequest(["get", "/\\fixture.invalid/api"])).toBeUndefined()
    expect(rawRequest(["get", "/api\\fixture.invalid"])).toBeUndefined()
  })

  test("rejects a foreign-origin request before invoking fetch", () => {
    let calls = 0
    const fetcher = (() => {
      calls++
      return Promise.resolve(new Response())
    }) as unknown as typeof fetch

    expect(() => fetchRequest(fetcher, "http://127.0.0.1:4096", "//fixture.invalid/api", {})).toThrow(
      "API request URL must match the daemon origin",
    )
    expect(calls).toBe(0)
  })

  test("keeps local API paths and queries on the daemon origin", () => {
    expect(requestURL("http://127.0.0.1:4096", "/api/foo?q=bar").href).toBe(
      "http://127.0.0.1:4096/api/foo?q=bar",
    )
  })

  test("invokes fetch for a local API path", async () => {
    let requestedURL: URL | undefined
    const fetcher = ((input: URL | RequestInfo) => {
      requestedURL = input instanceof URL ? input : new URL(input.toString())
      return Promise.resolve(new Response())
    }) as typeof fetch

    await fetchRequest(fetcher, "http://127.0.0.1:4096", "/api/foo?q=bar", {})
    expect(requestedURL?.href).toBe("http://127.0.0.1:4096/api/foo?q=bar")
  })
})
