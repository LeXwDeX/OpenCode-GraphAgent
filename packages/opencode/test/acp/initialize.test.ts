import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import * as ACPService from "../../src/acp/service"
import { commandName } from "../../src/command-name"

describe("acp initialize", () => {
  const service = ACPService.make({ sdk: {} as unknown as OpencodeClient })

  test("initialize auth method description uses dynamic command name", async () => {
    const result = await Effect.runPromise(service.initialize({ protocolVersion: 1, clientCapabilities: {} }))
    const method = result.authMethods?.[0]
    expect(method).toBeDefined()
    expect(method?.description).toContain(`\`${commandName()} auth login\``)
    expect(method?.description).not.toContain("`opencode auth login`")
  })

  test("initialize terminal-auth command equals commandName()", async () => {
    const result = await Effect.runPromise(
      service.initialize({
        protocolVersion: 1,
        clientCapabilities: { _meta: { "terminal-auth": true } },
      }),
    )
    const method = result.authMethods?.[0]
    expect(method?.description).toContain(`\`${commandName()} auth login\``)
    expect(method?.description).not.toContain("`opencode auth login`")
    const terminal = method?._meta?.["terminal-auth"] as { command?: string; args?: string[] } | undefined
    expect(terminal?.command).toBe(commandName())
    expect(terminal?.args).toEqual(["auth", "login"])
  })
})
