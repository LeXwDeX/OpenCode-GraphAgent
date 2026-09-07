import { test } from "node:test"
import assert from "node:assert/strict"
import { verifyEvidence } from "./ci-evidence.mjs"

const head = "a".repeat(40)
const base = "b".repeat(40)
function evidence() {
  const locator = { run: 12, attempt: 2, job: "Unit Tests (linux)", artifact: 34 }
  const expected = {
    job: locator.job,
    workflow: ".github/workflows/ci-test.yml",
    fingerprint: "tree-b",
    day: "2026-09-07",
    runner: "ubuntu-latest",
    artifactPrefix: "ci-verification-unit-tests-Linux-X64",
  }
  const run = { id: 12, run_attempt: 2, path: expected.workflow, head_sha: head, event: "push" }
  const jobs = [
    {
      name: locator.job,
      status: "completed",
      conclusion: "success",
      started_at: "2026-09-07T01:00:00Z",
      labels: ["ubuntu-latest"],
    },
  ]
  const artifact = {
    name: `${expected.artifactPrefix}-2`,
    size_in_bytes: 180,
    expired: false,
    workflow_run: { id: 12, head_sha: head },
  }
  const source = {
    run: () => run,
    jobs: () => jobs,
    artifact: () => artifact,
    proof: () => ({ fingerprint: "tree-b" }),
    fingerprint: (sha) => {
      assert.equal(sha, head)
      return "tree-b"
    },
  }
  return { locator, expected, run, jobs, source, artifact }
}

test("exact successful job and platform-associated source can be reused", () => {
  const e = evidence()
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), true)
})

for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", null]) {
  test(`source conclusion ${conclusion} cannot provide success evidence`, () => {
    const e = evidence()
    e.jobs[0].conclusion = conclusion
    assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  })
}

test("a still-running job cannot lend its early saved locator", () => {
  const e = evidence()
  e.jobs[0].status = "in_progress"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("a forged cache key for B pointing to a successful A tree is rejected", () => {
  const e = evidence()
  e.source.fingerprint = () => "tree-a"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("workflow and attempt identities cannot be borrowed", () => {
  const e = evidence()
  e.run.path = ".github/workflows/other.yml"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.run.path = e.expected.workflow
  e.run.run_attempt = 1
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("missing, ambiguous, or mismatched jobs are rejected", () => {
  const e = evidence()
  e.locator.job = "Typecheck"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.locator.job = e.expected.job
  e.jobs.push({ ...e.jobs[0] })
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.jobs.length = 0
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("live PR head updates do not overwrite the source run's immutable proof", () => {
  const e = evidence()
  e.run.event = "pull_request"
  e.run.pull_requests = [{ head: { sha: base }, base: { sha: base } }]
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), true)
})

test("a formerly tested merge tree cannot lend evidence to different current content", () => {
  const e = evidence()
  e.source.proof = () => ({ fingerprint: "different-merge-tree" })
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("malformed source identities fail closed", () => {
  const e = evidence()
  e.locator.run = "12"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.locator.run = 12
  e.run.head_sha = "untrusted-revision"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("a forged current-day key cannot reuse an old source job", () => {
  const e = evidence()
  e.jobs[0].started_at = "2026-09-06T01:00:00Z"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("the source job must use the expected runner label", () => {
  const e = evidence()
  e.jobs[0].labels = ["windows-latest"]
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("an artifact from another run or job cannot be borrowed", () => {
  const e = evidence()
  e.artifact.workflow_run.id = 99
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.artifact.workflow_run.id = 12
  e.artifact.name = "ci-verification-e2e-tests-Linux-X64-2"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("expired or unexpectedly large artifacts fall back to full verification", () => {
  const e = evidence()
  e.artifact.expired = true
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.artifact.expired = false
  e.artifact.size_in_bytes = 10001
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})
