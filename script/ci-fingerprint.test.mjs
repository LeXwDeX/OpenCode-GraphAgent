import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fingerprint } from "./ci-fingerprint.mjs"

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "ci-fingerprint-"))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
  git("init", "--quiet")
  const write = (path, content) => {
    mkdirSync(join(cwd, path, ".."), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  const snapshot = () => {
    git("add", "--all")
    return fingerprint(git("write-tree"), cwd)
  }
  write("product.ts", "export const answer = 42\n")
  return { cwd, git, write, snapshot }
}

test("record creation, updates, and deletion reuse unchanged product evidence", (t) => {
  const repo = repository(t)
  const baseline = repo.snapshot()
  repo.write(".specgit.yaml", "issues: [1]\n")
  assert.equal(repo.snapshot(), baseline)
  repo.write(".specgit.yaml", "issues: [2, 3]\n")
  assert.equal(repo.snapshot(), baseline)
  rmSync(join(repo.cwd, ".specgit.yaml"))
  assert.equal(repo.snapshot(), baseline)
})

for (const path of [
  "product.ts",
  "bun.lock",
  "spec_git/policy.yaml",
  ".github/workflows/ci-test.yml",
  "README.md",
  "nested/.specgit.yaml",
  "file\twith\nwhitespace",
]) {
  test(`${JSON.stringify(path)} changes invalidate verification`, (t) => {
    const repo = repository(t)
    const before = repo.snapshot()
    repo.write(path, "changed\n")
    repo.write(".specgit.yaml", "issues: [4]\n")
    assert.notEqual(repo.snapshot(), before)
  })
}

test("file modes, symlinks, and submodule revisions remain inputs", (t) => {
  const repo = repository(t)
  const baseline = repo.snapshot()
  repo.git("update-index", "--chmod=+x", "product.ts")
  assert.notEqual(fingerprint(repo.git("write-tree"), repo.cwd), baseline)
  const first = repo.git("hash-object", "-w", "product.ts")
  repo.write("other.ts", "other content\n")
  const second = repo.git("hash-object", "-w", "other.ts")
  for (const mode of ["120000", "160000"]) {
    repo.git("update-index", "--add", "--cacheinfo", `${mode},${first},linked`)
    const before = fingerprint(repo.git("write-tree"), repo.cwd)
    repo.git("update-index", "--cacheinfo", `${mode},${second},linked`)
    assert.notEqual(fingerprint(repo.git("write-tree"), repo.cwd), before)
  }
})

test("a delivery record with executable mode is not exempt", (t) => {
  const repo = repository(t)
  repo.write(".specgit.yaml", "issues: [1]\n")
  const baseline = repo.snapshot()
  repo.git("update-index", "--chmod=+x", ".specgit.yaml")
  assert.notEqual(fingerprint(repo.git("write-tree"), repo.cwd), baseline)
})

test("missing revision fails instead of manufacturing reusable evidence", (t) => {
  const repo = repository(t)
  assert.throws(() => fingerprint("missing-revision", repo.cwd))
})
