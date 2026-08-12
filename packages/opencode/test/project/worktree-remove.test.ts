import { $ } from "bun"
import { describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { stringify } from "yaml"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Worktree } from "../../src/worktree"
import { Project } from "../../src/project/project"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Worktree.defaultLayer, Project.defaultLayer, CrossSpawnSpawner.defaultLayer))
const wintest = process.platform === "win32" ? it.instance : it.instance.skip

describe("Worktree.remove", () => {
  it.instance(
    "continues when git remove exits non-zero after detaching",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const project = yield* Project.Service
        const svc = yield* Worktree.Service
        const name = `remove-regression-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())
        const current = yield* project.fromDirectory(root)
        yield* project.addSandbox(current.project.id, dir)

        const real = (yield* Effect.promise(() => $`which git`.quiet().text())).trim()
        expect(real).toBeTruthy()

        const bin = path.join(root, "bin")
        const shim = path.join(bin, "git")
        yield* Effect.promise(() => fs.mkdir(bin, { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            shim,
            [
              "#!/bin/bash",
              `REAL_GIT=${JSON.stringify(real)}`,
              'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
              '  "$REAL_GIT" "$@" >/dev/null 2>&1',
              '  echo "fatal: failed to remove worktree: Directory not empty" >&2',
              "  exit 1",
              "fi",
              'exec "$REAL_GIT" "$@"',
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() => fs.chmod(shim, 0o755))

        const prev = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const prev = process.env.PATH ?? ""
            process.env.PATH = `${bin}${path.delimiter}${prev}`
            return prev
          }),
          (prev) =>
            Effect.sync(() => {
              process.env.PATH = prev
            }),
        )
        void prev

        const ok = yield* svc.remove({ directory: dir })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        const list = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(root).quiet().text())
        expect(list).not.toContain(`worktree ${dir}`)

        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )

  wintest(
    "stops fsmonitor before removing a worktree",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `remove-fsmonitor-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())
        yield* Effect.promise(() => $`git config core.fsmonitor true`.cwd(dir).quiet())
        yield* Effect.promise(() => $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow())
        yield* Effect.promise(() => Bun.write(path.join(dir, "tracked.txt"), "next\n"))
        yield* Effect.promise(() => $`git diff`.cwd(dir).quiet())

        const before = yield* Effect.promise(() => $`git fsmonitor--daemon status`.cwd(dir).quiet().nothrow())
        expect(before.exitCode).toBe(0)

        const ok = yield* svc.remove({ directory: dir })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )

  const exists = (file: string) =>
    Effect.promise(() =>
      fs
        .stat(file)
        .then(() => true)
        .catch(() => false),
    )

  const legacyConfig = (model: string, enabled: boolean) =>
    JSON.stringify({
      schema_version: 1,
      enabled,
      model,
      topic_limit: 10,
      topic_limit_floor: 10,
      turn_interval: 5,
      injection: { max_topics: 3, max_tokens: 1_200 },
    })

  it.instance(
    "removing one worktree does not promote a lone sandbox config past disagreeing siblings (MEM-PR01-R1-06)",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const project = yield* Project.Service
        const svc = yield* Worktree.Service
        const current = yield* project.fromDirectory(root)
        yield* project.setInitialized(current.project.id)

        const stamp = Date.now().toString(36)
        const dirA = path.join(root, "..", `promote-a-${stamp}`)
        const dirB = path.join(root, "..", `promote-b-${stamp}`)
        yield* Effect.promise(() => $`git worktree add --no-checkout -b opencode/promote-a-${stamp} ${dirA}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git worktree add --no-checkout -b opencode/promote-b-${stamp} ${dirB}`.cwd(root).quiet())
        yield* project.addSandbox(current.project.id, dirA)
        yield* project.addSandbox(current.project.id, dirB)

        // Two sandboxes carry disagreeing legacy configs; the primary has none.
        yield* Effect.promise(() => Bun.write(path.join(dirA, ".opencode", "memory.jsonc"), legacyConfig("test/config-a", false)))
        yield* Effect.promise(() => Bun.write(path.join(dirB, ".opencode", "memory.jsonc"), legacyConfig("test/config-b", true)))

        // Removing A must reconcile against the FULL snapshot: A's lone config
        // disagrees with B's, so nothing may be promoted and the removal fails
        // closed instead of silently flipping the project-wide configuration.
        const outcome = yield* Effect.exit(svc.remove({ directory: dirA }))
        expect(Exit.isFailure(outcome)).toBe(true)
        expect(yield* exists(path.join(root, ".opencode", "memory.jsonc"))).toBe(false)
        expect(yield* exists(path.join(dirA, ".opencode", "memory.jsonc"))).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "worktree removal on an uninitialized project performs no memory migration (MEM-PR01-R1-08)",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const project = yield* Project.Service
        const svc = yield* Worktree.Service
        const current = yield* project.fromDirectory(root)
        // Deliberately NOT initialized: the spec keeps uninitialized projects inert.

        const stamp = Date.now().toString(36)
        const dirA = path.join(root, "..", `inert-${stamp}`)
        yield* Effect.promise(() => $`git worktree add --no-checkout -b opencode/inert-${stamp} ${dirA}`.cwd(root).quiet())
        yield* project.addSandbox(current.project.id, dirA)

        const now = "2026-08-12T00:00:00Z"
        const legacyTopic = stringify({
          schema_version: 1,
          id: "legacy-topic",
          name: "遗留主题",
          summary: "工作树中遗留的合法主题",
          metadata: {
            categories: ["decision"],
            status: "active",
            importance: "core",
            keywords: ["架构"],
            related_topics: [],
            created_at: now,
            updated_at: now,
            last_matched_at: null,
            match_count: 0,
            revision: 1,
            item_count: 1,
          },
          items: [
            {
              id: "legacy-item",
              kind: "decision",
              content: "已确认决定：核心模块之间使用稳定边界",
              rationale: "该边界由用户确认并长期适用",
              confirmed_at: now,
            },
          ],
        })
        yield* Effect.promise(() => Bun.write(path.join(dirA, ".opencode", "memory", "topics", "legacy-topic.yaml"), legacyTopic))

        // No migration may run for an uninitialized project: the legacy file
        // stays put and the removal fails closed on the residue.
        const outcome = yield* Effect.exit(svc.remove({ directory: dirA }))
        expect(Exit.isFailure(outcome)).toBe(true)
        expect(yield* exists(path.join(dirA, ".opencode", "memory", "topics", "legacy-topic.yaml"))).toBe(true)
      }),
    { git: true },
  )
})
