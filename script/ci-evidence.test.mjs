import { test } from "node:test"
import assert from "node:assert/strict"
import { verifyEvidence } from "./ci-evidence.mjs"

const head = "a".repeat(40)
const base = "b".repeat(40)
function evidence() {
  const locator = { run: 12, attempt: 2, job: "Unit Tests (linux)" }
  const expected = { job: locator.job, workflow: ".github/workflows/ci-test.yml", fingerprint: "tree-b" }
  const run = { id: 12, run_attempt: 2, path: expected.workflow, head_sha: head, event: "push" }
  const jobs = [{ name: locator.job, status: "completed", conclusion: "success" }]
  const source = {
    run: () => run,
    jobs: () => jobs,
    contains: () => true,
    fingerprint: (sha) => {
      assert.equal(sha, head)
      return "tree-b"
    },
  }
  return { locator, expected, run, jobs, source }
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

test("PR evidence requires proof that its tested merge tree equals its head tree", () => {
  const e = evidence()
  e.run.event = "pull_request"
  e.run.pull_requests = [{ head: { sha: head }, base: { sha: base } }]
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), true)
  e.source.contains = () => false
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.source.contains = () => true
  e.run.pull_requests[0].head.sha = base
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
