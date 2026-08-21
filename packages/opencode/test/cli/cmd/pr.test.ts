import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const prSource = readFileSync(path.resolve(import.meta.dir, "../../../src/cli/cmd/pr.ts"), "utf8")

describe("pr command spawn", () => {
  test("session import uses process.execPath instead of a hardcoded command name", () => {
    expect(prSource).toContain("Process.text([process.execPath, \"import\", sessionUrl]")
  })

  test("opencode spawn uses process.execPath instead of a hardcoded command name", () => {
    expect(prSource).toContain("Process.spawn([process.execPath, ...opencodeArgs]")
  })

  test("has no hardcoded opencode command arrays", () => {
    expect(prSource).not.toContain('["opencode",')
    expect(prSource).not.toContain('["opencode", "import"')
  })
})
