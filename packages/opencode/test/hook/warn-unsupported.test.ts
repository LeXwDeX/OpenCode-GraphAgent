import { describe, expect, test } from "bun:test"
import { detectUnsupportedFields, type Settings } from "@/hook/settings"

// hooks-api-fidelity: async / asyncRewake / `if` are all fully implemented
// (hook-async-execution + condition-filter) and MUST NOT be flagged as
// unsupported. Only `shell` remains a runtime placeholder and MUST still be
// flagged so users know it is inert.

const hooks = (hook: Record<string, unknown>): Settings["hooks"] => ({
  SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "true", ...hook }] }],
})

describe("detectUnsupportedFields", () => {
  test("async / asyncRewake are NOT flagged (implemented)", () => {
    const unsupported = detectUnsupportedFields(hooks({ async: true, asyncRewake: true }))
    expect(unsupported).toEqual([])
  })

  test("if is NOT flagged (condition-filter implements it)", () => {
    const unsupported = detectUnsupportedFields(hooks({ if: "Bash(npm *)" }))
    expect(unsupported).toEqual([])
  })

  test("shell is still flagged (placeholder)", () => {
    const unsupported = detectUnsupportedFields(hooks({ shell: "powershell" }))
    expect(unsupported).toHaveLength(1)
    expect(unsupported[0]).toMatchObject({ field: "shell", value: "powershell", eventName: "SessionStart" })
  })

  test("only shell is flagged when if+shell+async all present", () => {
    const unsupported = detectUnsupportedFields(
      hooks({ if: "Edit(*.ts)", shell: "bash", async: true, asyncRewake: true }),
    )
    expect(unsupported.map((u) => u.field).sort()).toEqual(["shell"])
  })

  test("undefined / empty hooks yield no flags", () => {
    expect(detectUnsupportedFields(undefined)).toEqual([])
    expect(detectUnsupportedFields({})).toEqual([])
  })

  // GOAL-FP/issue #286: HookCommand fields accepted by the schema but dropped
  // by every executor must be surfaced, not silently swallowed. `timeout` for
  // type "prompt" is implemented (excluded here); allowedEnvVars/statusMessage
  // have zero consumers anywhere, and per-command `once` is never read (only
  // the entry-level _sessionEntry?.once is consumed).
  test("allowedEnvVars / statusMessage / per-command once are flagged (dropped by executors)", () => {
    const unsupported = detectUnsupportedFields(
      hooks({ allowedEnvVars: ["FOO"], statusMessage: "hi", once: true }),
    )
    expect(unsupported.map((u) => u.field).sort()).toEqual(["allowedEnvVars", "once", "statusMessage"])
  })
})
