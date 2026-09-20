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
const repositoryFile = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")

const namedSteps = (source, name) => {
  const marker = `      - name: ${name}\n`
  const steps = []
  let start = source.indexOf(marker)
  while (start !== -1) {
    const next = source.indexOf("\n      - name: ", start + marker.length)
    steps.push(source.slice(start, next === -1 ? source.length : next))
    start = source.indexOf(marker, start + marker.length)
  }
  return steps
}

const runBody = (step) => {
  const marker = "\n        run: |\n"
  const start = step.indexOf(marker)
  assert.notEqual(start, -1, "step has no multiline run body")
  return step
    .slice(start + marker.length)
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n")
}

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

await test("manual release routes trusted Linux and Windows work while keeping macOS hosted", () => {
  const file = workflow("release-fork.yml")

  assert(!file.includes("pull_request:"), "release workflow must not accept pull request code")
  assert(file.includes("if: github.event_name == 'workflow_dispatch'"), "release work is not dispatch-gated")
  assert(file.includes("runner: [self-hosted, Linux, X64]"), "Linux build route")
  assert(file.includes("runner: [self-hosted, Windows, X64]"), "Windows build route")
  assert(file.includes("runner: macos-latest"), "macOS hosted route")
  assert.equal(file.split("runs-on: [self-hosted, Linux, X64]").length - 1, 5, "trusted Linux jobs")
  assert(!file.includes("runs-on: ubuntu-latest"), "trusted Linux job left on a hosted runner")
})

await test("release checkout credentials and third-party action versions are fixed", () => {
  const file = workflow("release-fork.yml")
  const checkout = "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5"
  const download = "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"
  const upload = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"

  assert.equal(file.split(checkout).length - 1, 5, "pinned checkout steps")
  assert.equal(file.split("persist-credentials: false").length - 1, 5, "credential-free checkout steps")
  assert.equal(file.split(download).length - 1, 3, "pinned download steps")
  assert.equal(file.split(upload).length - 1, 3, "pinned upload steps")
  assert(!/actions\/(?:checkout|download-artifact|upload-artifact)@v\d/.test(file), "mutable action tag remains")
})

await test("release candidate preparation is read-only and publication owns the only write token", () => {
  const file = workflow("release-fork.yml")
  const prepare = file.slice(file.indexOf("\n  prepare-release:"), file.indexOf("\n  publish-release:"))
  const publish = file.slice(file.indexOf("\n  publish-release:"), file.indexOf("\n  # No-op job"))

  assert(file.includes("default: false"), "publishing must be opt-in")
  assert(file.includes("permissions:\n  contents: read"), "workflow default permissions")
  assert(prepare.includes("Generate SHA256SUMS"), "candidate checksum preparation")
  assert(prepare.includes("Render Release Notes (fail closed)"), "candidate notes validation")
  assert(prepare.includes("Verify Release Candidate"), "candidate verification")
  assert(prepare.includes("Setup GitHub CLI"), "read-only GitHub CLI bootstrap")
  assert(prepare.includes("uses: ./.github/actions/setup-gh"), "prepare uses the shared verified bootstrap")
  assert(prepare.includes("SELECTED_PLATFORMS: ${{ inputs.platforms }}"), "platform input env boundary")
  assert(prepare.includes('selected="$SELECTED_PLATFORMS"'), "shell reads the platform input from env")
  assert(!prepare.includes('selected="${{ inputs.platforms }}"'), "platform input must not be interpolated into shell")
  for (const archive of ["opencode-linux-*.tar.gz", "opencode-darwin-*.zip", "opencode-windows-*.zip"])
    assert(prepare.includes(archive), `selected platform archive check: ${archive}`)
  assert(prepare.includes("Upload Release Candidate"), "candidate artifact upload")
  assert(!prepare.includes("contents: write"), "prepare job gained write permission")
  assert(!prepare.includes("GH_TOKEN"), "prepare job gained a write token")
  assert(publish.includes("if: inputs.create_release"), "publish opt-in guard")
  assert(publish.includes("permissions:\n      contents: write"), "publish write permission")
  assert(publish.includes("GH_TOKEN: ${{ github.token }}"), "publish token")
  assert(publish.includes('--repo "${{ github.repository }}"'), "publish must name the repository without checkout")
  assert.equal(file.split("contents: write").length - 1, 1, "only publish may write contents")
  assert.equal(file.split("GH_TOKEN: ${{ github.token }}").length - 1, 1, "only publish receives GH_TOKEN")
  assert(file.includes("set -o pipefail"), "template provenance capture must preserve packager failures")
  assert(file.includes("Verify Template Provenance"), "template provenance validation")
  for (const field of ["runtime_commit", "template_commit", "compat_runtime_sha"])
    assert(file.includes(field), `template provenance field: ${field}`)
  assert(file.includes("command -v sha256sum"), "Linux checksum fallback")
  assert(publish.includes('"${assets[@]}"'), "publish must tolerate a selected platform subset")
})

await test("dev issue auto-close uses the trusted Linux runner without checking out PR code", () => {
  const file = workflow("dev-issue-autoclose.yml")
  assert(file.includes("github.event.pull_request.merged == true"), "merged-event gate")
  assert(file.includes("github.event.pull_request.base.ref == 'dev'"), "dev-base gate")
  assert(file.includes("runs-on: [self-hosted, Linux, X64]"), "trusted Linux route")
  assert(file.includes("timeout-minutes: 10"), "bounded job")
  assert(!file.includes("uses: actions/checkout"), "event helper must not check out PR code")
})

await test("verified GitHub CLI bootstrap pins supported archives and verifies before extracting", () => {
  const action = repositoryFile(".github/actions/setup-gh/action.yml")
  const setup = repositoryFile(".github/actions/setup-gh/setup.sh")
  const version = "2.101.0"
  const linuxSha = "9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8"
  const windowsSha = "bc6c814367b193cd8e713611d61e36013c0ef843b8f516458fe3eda039192794"

  for (const value of [version, linuxSha, windowsSha, `https://github.com/cli/cli/releases/download/v${version}`])
    assert(action.includes(value), `missing immutable GitHub CLI pin: ${value}`)
  assert(!action.includes("GH_TOKEN"), "bootstrap must download public assets anonymously")
  assert(!action.includes("GITHUB_TOKEN"), "bootstrap must not receive a repository token")

  for (const contract of [
    "Linux:X64",
    "Windows:X64",
    `gh_\${GH_CLI_VERSION}_linux_amd64/bin/gh`,
    "bin/gh.exe",
    "Unsupported GitHub CLI bootstrap platform",
    "archive checksum mismatch",
    "Expand-Archive -LiteralPath",
    "GH_CLI_ARCHIVE_WINDOWS",
    "GH_CLI_EXTRACT_WINDOWS",
    "cygpath -w",
    "--connect-timeout 20 --max-time 300 --retry 3 --retry-delay 1",
  ])
    assert(setup.includes(contract), `bootstrap contract: ${contract}`)

  const checksum = setup.indexOf('if [ "$actual" != "$expected" ]')
  const linuxExtract = setup.indexOf('tar -xzf "$archive"')
  const windowsExtract = setup.indexOf("Expand-Archive -LiteralPath")
  assert(checksum !== -1 && checksum < linuxExtract, "Linux extraction must follow checksum verification")
  assert(checksum !== -1 && checksum < windowsExtract, "Windows extraction must follow checksum verification")
})

await test("jobs that check out repository content bootstrap gh before evidence reuse", () => {
  const typecheck = workflow("ci-typecheck.yml")
  const tests = workflow("ci-test.yml")
  assert.equal(typecheck.split("uses: ./.github/actions/setup-gh").length - 1, 1, "typecheck bootstrap count")
  assert(
    typecheck.indexOf("uses: ./.github/actions/setup-gh") <
      typecheck.indexOf("uses: ./.github/actions/verified-content"),
  )
  assert(typecheck.includes("run: bash script/setup-gh.test.sh"), "bootstrap fixture test is not wired")

  const testBootstraps = [...tests.matchAll(/uses: \.\/\.github\/actions\/setup-gh/g)].map((match) => match.index)
  const evidenceSteps = [...tests.matchAll(/uses: \.\/\.github\/actions\/verified-content/g)].map(
    (match) => match.index,
  )
  assert.equal(testBootstraps.length, 2, "unit/e2e bootstrap count")
  assert.equal(evidenceSteps.length, 2, "unit/e2e evidence count")
  for (let index = 0; index < testBootstraps.length; index++)
    assert(testBootstraps[index] < evidenceSteps[index], `test job ${index + 1} bootstraps gh after evidence`)
})

await test("privileged no-checkout jobs share an anonymous fail-closed Linux bootstrap", () => {
  const release = workflow("release-fork.yml")
  const autoclose = workflow("dev-issue-autoclose.yml")
  const publish = release.slice(release.indexOf("\n  publish-release:"), release.indexOf("\n  # No-op job"))
  const publishSetup = namedSteps(publish, "Setup GitHub CLI")[0]
  const autocloseSetup = namedSteps(autoclose, "Setup GitHub CLI")[0]

  assert(publishSetup, "publish bootstrap missing")
  assert(autocloseSetup, "autoclose bootstrap missing")
  assert.equal(runBody(publishSetup), runBody(autocloseSetup), "privileged inline bootstrap implementations drifted")
  for (const step of [publishSetup, autocloseSetup]) {
    assert(step.includes('GH_CLI_VERSION: "2.101.0"'), "inline version pin")
    assert(step.includes("9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8"), "inline Linux SHA pin")
    assert(step.includes('"${RUNNER_OS:-}" != "Linux"'), "inline OS rejection")
    assert(step.includes('"${RUNNER_ARCH:-}" != "X64"'), "inline architecture rejection")
    assert(!step.includes("GH_TOKEN"), "bootstrap step must not receive GH_TOKEN")
    assert(!step.includes("GITHUB_TOKEN"), "bootstrap step must not receive GITHUB_TOKEN")
    assert(step.indexOf('if [ "$actual" != "$GH_CLI_LINUX_AMD64_SHA256" ]') < step.indexOf('tar -xzf "$archive"'))
  }
  assert(!publish.includes("uses: actions/checkout"), "publish must remain no-checkout")
  assert(!autoclose.includes("uses: actions/checkout"), "autoclose must remain no-checkout")
})
