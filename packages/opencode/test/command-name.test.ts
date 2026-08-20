import { describe, expect, test } from "bun:test"
import { basename } from "path"
import { commandName } from "../src/command-name"
import { FormatError } from "../src/cli/error"

describe("commandName", () => {
  test("returns the basename of the current executable", () => {
    expect(commandName()).toBe(basename(process.execPath))
    expect(commandName().length).toBeGreaterThan(0)
  })

  test("has no path separators", () => {
    const name = commandName()
    expect(name).toBe(basename(process.execPath))
    expect(name.length).toBeGreaterThan(0)
    expect(name.includes("/")).toBe(false)
    expect(name.includes("\\")).toBe(false)
  })

  test("user-facing model-not-found hint uses the dynamic command name", () => {
    const formatted = FormatError({
      name: "ProviderModelNotFoundError",
      data: {
        providerID: "anthropic",
        modelID: "claude-sonet-4",
        suggestions: ["claude-sonnet-4"],
      },
    })
    expect(formatted).toContain(`Try: \`${commandName()} models\` to list available models`)
    expect(formatted).not.toContain("`opencode models`")
  })
})
