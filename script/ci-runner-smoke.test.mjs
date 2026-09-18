import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

// The dispatch-only probe for the repository-scoped self-hosted runners. It
// must never execute repository code, request a token, run on macOS or expose
// anything beyond runner attribution, so every property below is asserted
// against the workflow text directly (no YAML dependency).
const workflow = readFileSync(new URL("../.github/workflows/runner-smoke.yml", import.meta.url), "utf8")
const typecheck = readFileSync(new URL("../.github/workflows/ci-typecheck.yml", import.meta.url), "utf8")

function section(name) {
  const lines = workflow.split("\n")
  const start = lines.findIndex((line) => line === `${name}:`)
  assert(start >= 0, `missing ${name}: section`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^[a-z]/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join("\n")
}

await test("runner smoke is dispatch-only with a required linux/windows choice", () => {
  const trigger = section("on")
  assert(trigger.includes("workflow_dispatch:"), "manual dispatch trigger")
  assert(trigger.includes("required: true"), "platform input is required")
  assert(trigger.includes("type: choice"), "platform input is a choice")
  assert(trigger.includes("- linux"), "linux option")
  assert(trigger.includes("- windows"), "windows option")
  for (const forbidden of ["push:", "pull_request", "schedule:", "merge_group"])
    assert(!trigger.includes(forbidden), `forbidden trigger: ${forbidden}`)
})

await test("runner smoke selects exactly one standard self-hosted platform per dispatch", () => {
  const routes = workflow.split("\n").filter((line) => line.includes("runs-on:"))
  assert.equal(routes.length, 2, "one route per platform")
  assert(
    routes.some((line) => line.includes("[self-hosted, Linux, X64]")),
    "linux labels",
  )
  assert(
    routes.some((line) => line.includes("[self-hosted, Windows, X64]")),
    "windows labels",
  )
  for (const line of routes) assert(!/macos|darwin|arm64/i.test(line), `macOS route: ${line.trim()}`)
  assert(workflow.includes("if: inputs.platform == 'linux'"), "linux guard")
  assert(workflow.includes("if: inputs.platform == 'windows'"), "windows guard")
})

await test("runner smoke runs no repository or third-party code and holds no token", () => {
  assert(!/\buses:/.test(workflow), "no action can run")
  assert(!workflow.includes("actions/checkout"), "no repository checkout")
  assert(!workflow.includes("secrets."), "no secret reference")
  assert(!workflow.includes("github.token"), "no job token")
  assert(!/permissions:\s*write/.test(workflow), "no write permission")
  assert(!/permissions:\s*contents:\s*read/.test(section("jobs")), "no workflow-level fallback token")
  assert.equal((workflow.match(/permissions: \{\}/g) ?? []).length, 2, "each job disables the token")
})

await test("runner smoke is bounded and only reports attribution evidence", () => {
  assert.equal((workflow.match(/timeout-minutes: 10/g) ?? []).length, 2, "ten minute bound per job")
  for (const evidence of ["RUNNER_NAME", "RUNNER_ENVIRONMENT", "hostname", "whoami"])
    assert(workflow.includes(evidence), `missing attribution evidence: ${evidence}`)
})

await test("the typecheck job executes the smoke contract test", () => {
  assert(typecheck.includes("script/ci-runner-smoke.test.mjs"), "smoke test wired into typecheck")
})
