import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { fingerprint } from "./ci-fingerprint.mjs"

export function verifyEvidence(locator, expected, source) {
  if (!Number.isSafeInteger(locator.run) || locator.run <= 0) return false
  if (!Number.isSafeInteger(locator.attempt) || locator.attempt <= 0) return false
  if (locator.job !== expected.job) return false
  const run = source.run(locator.run, locator.attempt)
  if (run.id !== locator.run || run.run_attempt !== locator.attempt || run.path !== expected.workflow) return false
  if (!/^[a-f0-9]{40}$/.test(run.head_sha)) return false
  if (!["push", "pull_request", "workflow_dispatch"].includes(run.event)) return false
  const jobs = source.jobs(locator.run, locator.attempt).filter((job) => job.name === expected.job)
  if (jobs.length !== 1 || jobs[0].status !== "completed" || jobs[0].conclusion !== "success") return false
  if (jobs[0].started_at?.slice(0, 10) !== expected.day) return false
  if (!jobs[0].labels?.includes(expected.runner)) return false
  if (run.event === "pull_request") {
    // A divergent PR tests a synthetic merge tree. Without immutable evidence
    // of that tree, run the suite again instead of attributing it to its head.
    if (run.pull_requests?.length !== 1) return false
    const pr = run.pull_requests[0]
    if (pr.head?.sha !== run.head_sha || !/^[a-f0-9]{40}$/.test(pr.base?.sha)) return false
    if (!source.contains(run.head_sha, pr.base.sha)) return false
  }
  return source.fingerprint(run.head_sha) === expected.fingerprint
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env.EVIDENCE
  if (process.argv[2] === "record") {
    writeFileSync(
      path,
      JSON.stringify({
        run: Number(process.env.GITHUB_RUN_ID),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        job: process.env.CHECK_JOB,
      }),
    )
  } else {
    let reused = false
    try {
      const repo = process.env.GITHUB_REPOSITORY
      const api = (path) =>
        JSON.parse(
          execFileSync("gh", ["api", `repos/${repo}/${path}`], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        )
      const fetched = new Set()
      const fetch = (sha) => {
        if (fetched.has(sha)) return
        execFileSync("git", ["fetch", "--no-tags", "--depth=256", "origin", sha], {
          stdio: ["ignore", "pipe", "pipe"],
        })
        fetched.add(sha)
      }
      reused = verifyEvidence(
        JSON.parse(readFileSync(path, "utf8")),
        {
          job: process.env.CHECK_JOB,
          runner: process.env.CHECK_RUNNER,
          day: new Date().toISOString().slice(0, 10),
          workflow: process.env.GITHUB_WORKFLOW_REF.split("@")[0].slice(repo.length + 1),
          fingerprint: process.env.PRODUCT_FINGERPRINT,
        },
        {
          run: (run, attempt) => api(`actions/runs/${run}/attempts/${attempt}`),
          jobs: (run, attempt) => {
            const jobs = []
            for (let page = 1; ; page++) {
              const result = api(`actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`)
              jobs.push(...result.jobs)
              if (result.jobs.length < 100) return jobs
            }
          },
          contains: (head, base) => {
            fetch(head)
            fetch(base)
            try {
              execFileSync("git", ["merge-base", "--is-ancestor", base, head], { stdio: "pipe" })
              return true
            } catch {
              return false
            }
          },
          fingerprint: (sha) => {
            fetch(sha)
            return fingerprint(sha)
          },
        },
      )
    } catch {
      console.log("Previous verification could not be proven; running the full suite.")
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `reused=${reused}\n`)
    if (reused) {
      const locator = JSON.parse(readFileSync(path, "utf8"))
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Reused successful product verification\n\nGitHub confirms the source job completed successfully today on the requested runner label, and its product tree matches this checkout. Only the ordinary root SpecGit record is excluded.\n\nSource: ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${locator.run}/attempts/${locator.attempt}\n`,
      )
    }
  }
}
