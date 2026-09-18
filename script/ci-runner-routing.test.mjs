import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

// The one trusted-event predicate that gates every self-hosted route: pushes,
// manual dispatches, and pull requests whose head branch lives in this
// repository. Fork pull requests and dependabot keep GitHub-hosted runners.
// This routing reduces exposure only; a fork pull request runs its own copy of
// the workflow, so the self-hosted services stay stopped until the repository
// admission policy is accepted.
const TRUSTED =
  "(github.event_name == 'push' || github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.login != 'dependabot[bot]' && github.actor != 'dependabot[bot]'))"

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8")

await test("self-hosted routes are gated by the trusted-event predicate and keep a hosted fallback", () => {
  for (const file of ["ci-typecheck.yml", "ci-test.yml"]) {
    const lines = workflow(file).split("\n")
    const routes = lines.filter((line) => line.trimStart().startsWith("runs-on:"))
    const selfHostedRoutes = routes.filter(
      (line) => line.includes("self-hosted") || line.includes("matrix.settings.selfHosted"),
    )
    assert(selfHostedRoutes.length > 0, `${file}: no self-hosted route`)
    for (const line of selfHostedRoutes) {
      assert(line.includes(TRUSTED), `${file}: ungated self-hosted route\n${line.trim()}`)
      assert(
        line.includes("'ubuntu-latest'") || line.includes("matrix.settings.host"),
        `${file}: self-hosted route lost its hosted fallback\n${line.trim()}`,
      )
    }
    const labels = lines.filter((line) => line.trimStart().startsWith("runner-label:"))
    assert.equal(labels.length, routes.length, `${file}: one evidence label per route`)
    for (const line of labels) {
      assert(line.includes(TRUSTED), `${file}: ungated evidence label\n${line.trim()}`)
      assert(
        line.includes("self-hosted") || line.includes("matrix.settings.selfHosted"),
        `${file}: evidence label lacks the self-hosted platform\n${line.trim()}`,
      )
    }
  }
})

await test("the typecheck job selects the standard self-hosted Linux labels only when trusted", () => {
  const typecheck = workflow("ci-typecheck.yml")
  assert(
    typecheck.includes(`runs-on: \${{ ${TRUSTED} && fromJSON('["self-hosted","Linux","X64"]') || 'ubuntu-latest' }}`),
    "typecheck route",
  )
  assert(
    typecheck.includes(`runner-label: \${{ ${TRUSTED} && 'self-hosted,Linux,X64' || 'ubuntu-latest' }}`),
    "typecheck evidence label",
  )
})

await test("the test matrix keeps names and OS keys while carrying standard self-hosted label arrays", () => {
  const file = workflow("ci-test.yml")
  assert(file.includes(`runs-on: \${{ ${TRUSTED} && matrix.settings.selfHosted || matrix.settings.host }}`))
  for (const line of [
    `runner-label: \${{ ${TRUSTED} && join(matrix.settings.selfHosted, ',') || matrix.settings.host }}`,
    "selfHosted: [self-hosted, Linux, X64]",
    "selfHosted: [self-hosted, Windows, X64]",
    "name: Unit Tests (${{ matrix.settings.name }})",
    "name: E2E Tests (${{ matrix.settings.name }})",
  ])
    assert(file.includes(line), line)
  assert.equal(file.split("selfHosted: [self-hosted, Linux, X64]").length - 1, 2, "linux matrix rows")
  assert.equal(file.split("selfHosted: [self-hosted, Windows, X64]").length - 1, 1, "windows matrix row")
})

await test("self-hosted Linux jobs never require sudo: prerequisites are checked and fail actionably", () => {
  const file = workflow("ci-test.yml")
  assert(!file.includes("run: sudo apt-get"), "a step still installs with sudo directly")
  assert(file.includes('if [ "$RUNNER_ENVIRONMENT" = "self-hosted" ]; then'), "ripgrep self-hosted branch")
  assert(
    file.includes(
      "::error::ripgrep (rg) is required but missing on this self-hosted runner. Provision it on the host; CI jobs run without sudo.",
    ),
    "ripgrep actionable failure",
  )
  assert(
    file.includes("(runner.environment == 'github-hosted')"),
    "Playwright system dependencies install on hosted runners only",
  )
  assert(
    file.includes("(runner.environment == 'self-hosted')"),
    "Playwright Chromium verification runs on self-hosted runners",
  )
  assert(
    file.includes(
      "::error::Chromium cannot start on this self-hosted runner. Provision the Playwright Chromium system dependencies on the host; CI jobs run without sudo.",
    ),
    "Playwright actionable failure",
  )
})

await test("privileged release and issue automation stay on GitHub-hosted runners", () => {
  for (const file of ["release-fork.yml", "dev-issue-autoclose.yml"]) {
    const content = workflow(file)
    assert(content.includes("runs-on: ubuntu-latest"), `${file}: hosted runner lost`)
    assert(!content.includes("self-hosted"), `${file}: privileged job moved to self-hosted`)
  }
})
