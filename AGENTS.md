- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- The default branch in this repo is `main`.

## Git Workflow (铁律)

```
feat/**, fix/** ──PR(Typecheck + Unit Tests 门禁)──▶ dev ──push 触发全量测试──▶
    dev ──手动 release-fork──▶ prerelease 测试版
    dev ──PR(全量测试门禁)──▶ main ──手动 release-fork──▶ 正式版
```

**分层门禁**：`dev` 是快速集成层（Typecheck + Unit Tests (linux)；E2E 不阻塞），`main` 是正式质量门禁（Typecheck + 全量 Unit Tests + E2E）。所有改动通过 PR 流转，禁止直推 `main` 和 `dev`（由 GitHub Rulesets 强制）。

| Branch | 直推 | PR 门禁 | CI 触发 | Purpose |
|--------|------|---------|---------|---------|
| `{type}/**` | ✅ 允许 | — | push 不触发；PR 触发目标分支门禁 | 开发分支，频繁变更 |
| `dev` | ❌ 禁止 | PR 必须通过 **Typecheck + Unit Tests (linux)** | ✅ push 触发 Typecheck + 全量测试 | 快速集成层 |
| `main` | ❌ 禁止 | PR 必须通过 **Typecheck + Unit Tests + E2E (linux + windows) + SpecGit Acceptance** | ✅ push 触发全量 | 正式质量门禁 + 发版 |

**流程**：
1. 从 `main` 切出 `feat/**` 或 `fix/**` 分支开发
2. PR → `dev`（Typecheck + Unit Tests (linux) 门禁，快速合并）
3. push 到 `dev` 自动触发全量测试验证
4. 从 `dev` 手动 `release-fork` → 产出 **prerelease** 测试版
5. PR `dev` → `main`（全量测试门禁：Typecheck + Unit Tests + E2E）
6. 合并到 `main` 后手动 `release-fork` → 产出**正式版**

**Rulesets（GitHub Settings → Rules → Rulesets）**：
- `protect-main`：禁止直推/删除/force-push；PR 需通过 5 项检查（Typecheck、Unit Tests (linux)、E2E Tests (linux)、E2E Tests (windows)、SpecGit Acceptance）
- `protect-dev`：禁止直推/删除/force-push；PR 需通过 Typecheck
- `branch-naming`：只允许创建 `feat/**`、`fix/**`、`chore/**`、`docs/**`、`refactor/**`、`test/**`、`release/**`、`hotfix/**` 前缀的新分支

**CI 配置**：
- `ci-typecheck.yml`：push 到 `main`/`dev` + PR → `main`/`dev` 时触发；除 lint + typecheck 外还跑 `test:dag-core` DAG 核心行为/覆盖率门禁（10min 超时）
- `ci-test.yml`：push 到 `main`/`dev` + PR → `main`/`dev` 时触发全量测试（`cancel-in-progress: false` 保证跑完）；Linux unit-tests job 额外校验生成物新鲜度（`packages/client` 与 `packages/sdk/js` 的 `check:generated`）并跑 HttpAPI 契约门禁（`test:httpapi:ci`）
- `specgit-accept.yml`：PR → `main` 和手动 dispatch 时运行当前提交的 SpecGit Acceptance；CLI 隔离安装、分支恢复和等待预算见下方 "SpecGit harness local specializations"。
- `release-fork.yml`：手动 `workflow_dispatch` 是唯一真实构建路径（push 到 `main`/`dev` 仅注册不构建）；从 `dev` 发布自动产出 `X.Y.Z-dev.N` prerelease，从 `main` 发布 `X.Y.Z` 并标 Latest

## Standard Delivery Workflow (标准交付流程)

新功能开发、Debug 等一切交付范畴恒定走此循环；后续所有工作必须遵守该方案，不得另起流程：

1. **确立条目**：明确条目的内容、范围、类型（`feat`/`fix`/…）。一个 issue = 一个可独立验证的 WHY，无法独立验证的先拆分再立项。
2. **SpecGit 立项**：`script/specgit-bootstrap.sh <title-or-number>` 创建/复用 issues 批次，确立交付分支与草稿 PR 脚手架（`.specgit.yaml` 绑定）；立项前先查重，避免同一 WHY 双开。wrapper 是 canonical 入口（见 "SpecGit harness local specializations"）；直跑裸 `specgit issue` 预期被 harness currency gate 以 `harness_stale` (exit 2) 拒绝。
3. **超流执行**：安排 DAG workflow（超流）承载实现——并行开发 + 多角度 Review + 复合（synthesize），其产出作为交付证据基线。
4. **PR 过门禁**：SpecGit 发起/推进 PR，过 TDD 与 CI 门禁（Typecheck、Unit Tests、DAG gate）；`specgit finish` exit 0 表示 accepted，合并和所有绑定 issue 关闭后才完成交付。
5. **修复门禁问题**：门禁失败在交付分支修代码/测试，永远不削弱门禁本身。
6. **合并收尾**：完成 PR 合并（目标分支遵循 Git Workflow，dev 为集成层），PR 正文 `Closes #n` 自动关闭绑定 issues；版本确立与发布按 release train 既有节奏推进。

## Branch Names

Format: `{type}/{short-name}` where `type` is one of: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `release`, `hotfix`. The short name uses hyphens, at most three words. Enforced by GitHub Ruleset `branch-naming`.

Examples: `feat/session-recovery`, `fix/scroll-state`, `docs/branch-naming`, `refactor/dag-spawn`, `test/auth-flow`, `chore/regenerate-sdk`, `release/v1.18`, `hotfix/critical-patch`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.
- `bun run test:dag-core`（在 `packages/opencode`）：DAG 核心行为与覆盖率门禁，随 ci-typecheck 对每个 PR 强制执行；改状态机/持久化先本地跑它。

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly. Root `bun run typecheck` (turbo) covers all packages.
- `bun run build` does not typecheck — esbuild transpiles only. A green build can still ship a missing import or a non-existent API, so it is not proof the code is sound. `bun typecheck` (`tsgo --noEmit`) is the commit gate.
- `bun run lint`（仓库根）= `oxlint --max-warnings=4850` 警告数棘轮：任何新增 oxlint 警告都会撑破预算、炸掉 CI Typecheck job——修警告，永远不要抬上限。

## Extending the Codebase (二次开发)

Guiding invariants for adding services, HTTP API routes, or features. The build pipeline will not catch violations of these — only an understanding of the architecture will. Read the surrounding modules first (`src/memory` and `src/config` are good references for lightweight, self-contained services) before wiring new dependencies.

- Keep each `X.defaultLayer` self-contained. It must `Layer.provide` every dependency its layer body `yield*`s at construction. `Layer.provideMerge(self, layer)` builds `layer` in isolation — the context accumulated by `self` is not fed to it — and `Layer.mergeAll` does not cross-provide siblings. A layer that quietly assumes an ambient service will construct in one entry point and crash in another, surfacing as a runtime crash or a blank/unresponsive TUI rather than a build error.
- `LayerNode` (`.node` exports, `LayerNode.buildLayer`) is a second, parallel composition system, separate from `defaultLayer`/`AppLayer`. The same self-containment rule applies per node, but the two systems don't share wiring. When adding a service that other services should see, find every consumer's `.node` list (not just its `defaultLayer`) and add the new service's node there.
- Resolve optional or heavyweight cross-dependencies lazily. When a service needs something already built elsewhere in `AppLayer` — especially something with deep transitive deps (Provider, MCP, HttpClient) — reach for `Effect.serviceOption(Tag)` at the call site instead of a hard `yield* Tag` in the layer body. This keeps the layer lightweight, leaves the consumer's requirements (`R`) empty, and stops transitive deps from being dragged into every entry point that builds the layer. A missing wire here compiles clean and fails silently (feature just no-ops) instead of erroring — grep every `Effect.serviceOption(X.Service)` call site, confirm X's node/layer actually reaches it, and verify with an integration test that exercises the behavior, not just that the layer builds.
- Regenerate the JS SDK after touching HTTP API routes. The SDK under `packages/sdk/js` is generated from the API's OpenAPI spec; adding or renaming a route does not update it. A stale SDK breaks the TUI at runtime — calling a client method that does not yet exist — in a way typecheck cannot catch, because the generated types are the client's source of truth. After route changes, run `./packages/sdk/js/script/build.ts` and rebuild the consumers. CI enforces this: the `Check generated SDK` step in `ci-test.yml` runs `bun run check:generated` in `packages/sdk/js` (regenerate + `git diff --exit-code -- src/v2/gen`), so a forgotten regeneration fails the Linux unit-tests job instead of surfacing at TUI runtime.
- Changing an HTTP API route's request/response shape requires updating its scenario in `test/server/httpapi-exercise/index.ts`. `bun run test:httpapi --fail-on-missing` fails CI otherwise.

### TUI (packages/tui)

Invariants for extending the SolidJS/opentui TUI. The DAG inspector (`src/feature-plugins/system/dag-inspector.tsx`) plus its sidebar indicator and summary pipeline are the reference implementation for a server-driven TUI feature.

- TUI builtins live under `src/feature-plugins/` and are registered in `feature-plugins/builtins.ts`. A builtin exports `{ id, tui }` where the `TuiPlugin` function registers routes (`api.route.register`), palette commands (`api.keymap.registerLayer`), and sidebar slots (`api.slots.register`). Register only the `*.open` palette command at plugin level; everything else belongs to the route component.
- Route-scoped keyboard commands go inside the route component via `useBindings` (from `src/keymap`) with `props.api.tuiConfig.keybinds.gather("<prefix>", commandNames)`, so they are active only while the route is mounted and user overrides apply. Every command needs entries in both `Definitions` and `CommandMap` in `src/config/keybind.ts`; a command missing there cannot be rebound and won't appear in keybind config schema. Follow the diff-viewer's key vocabulary (`escape,q` close, `j/k` move, `enter` activate) for consistency.
- Server-driven shared state lives in `src/context/sync.tsx`: one store slice + one event reducer case per domain, plus an initial fetch during bootstrap as the safety net for events missed before the event stream subscribes. `SyncProvider` requires `ExitProvider` (plus Args/KV/SDK/Project providers); any test harness mounting it must wrap with all of them — see `test/cli/cmd/tui/sync-fixture.tsx`.
- Every event type the TUI consumes must be defined with `define()` in `packages/schema` and included in `EventManifest.Definitions`, or the generated SDK event union won't contain it and the reducer case can't typecheck. Ephemeral push events (e.g. `dag.workflow.summary.updated`) stay OUT of the durable-event manifest: emit them via `GlobalBus`, never persist them, and design consumers to tolerate missed events (re-fetch on bootstrap).
- Types shared between server and TUI come from the generated SDK (`@opencode-ai/sdk/v2`). Do not hand-duplicate response/summary interfaces in `packages/plugin/src/tui.ts` or TUI code — re-export the SDK type (`export type TuiSidebarDagItem = DagWorkflowSummary`), so a server schema change surfaces as a typecheck error instead of silent drift.
- Prefer server-side aggregation for display data. The TUI renders `DagStore.getWorkflowSummaries` output verbatim; it never aggregates raw `dag.*` events client-side. Derived-view publishers (server-side `packages/opencode/src/dag/runtime/summary-publisher.ts`) must stay stateless: recompute from the store on every emission, no module-level caches.
- Extract non-trivial pure logic (topology layout, tree building) into a sibling `*-utils.ts` with unit tests, mirroring `diff-viewer-file-tree-utils.ts` / `dag-inspector-utils.ts`. Component files stay declarative.
- Async fetches inside components must guard against stale responses (check the selection still matches before `setState`) and clean up event subscriptions with `onCleanup`.

## V2 Session Core

_This section was removed: the `SessionV2`/`SessionExecution`/`SessionRunner`/`SessionRunCoordinator` vocabulary it described no longer exists in the codebase. The current session runtime lives in `packages/opencode/src/session/` (`prompt.ts`, `processor.ts`, `compaction.ts`); read `src/session/CONTEXT.md`-adjacent module docs there before extending it._

## DAG Configuration Repository

The authoritative repository for curated DAG workflow YAML and configuration-owned block or prompt assets is [`LeXwDeX/opencode-dag-config`](https://github.com/LeXwDeX/opencode-dag-config). Inspect and update that repository when a task changes reference workflows, composable block configurations, or their embedded worker prompts; configuration-only changes do not belong in this runtime repository.

This repository owns the DAG schema, compiler, validator, runtime, and release integration. Changes that cross the boundary land runtime support first, then update the config repository's `runtime-compat.json` to the merged full runtime commit SHA and pass its template-validation CI.

## DAG command family

- Built-in commands ship compiled into the binary: `/dag-auto` (requirement → workflow routing: classify, match a saved DAG route, retarget, validate, start). Platform delivery (issues, PRs, CI, merge, release) is specgit's job — never part of `/dag-*`. User command files shadow built-ins by name; register new built-ins through `packages/core/src/plugin/command.ts` + `packages/opencode/src/command/index.ts` (`Default` registry).
- Templates come from `opencode-dag-config`: 7 domains × `full`/`lite` plus cross-domain routes (`ultra-flow-route`, `release-route`). Precedence: project `.opencode/workflows/` > global config dir > builtin snapshot (the release pipeline compiles the config repo into the binary via `DAG_TEMPLATES_DIR`).
- `~/.config/opencode/dag.jsonc`（全局用户配置，非仓库文件）supplies DAG node model tiers: `advanced` for `required: true` and review nodes, `standard` otherwise. Never pin `model` inside saved workflow specs.

## Project memory

- Memory is fail-closed inert until the project is initialized: running `/init` stamps `project.time_initialized`, which `/memory on` and `memory_search` require. `/memory on` silently answering "Memory remains off" means the project never ran `/init` (or has no real git identity).
- Model 与节奏配置在 `~/.config/opencode/memory.jsonc`（enabled、model、turn_interval、注入上限）。openai-compatible 供应商会把 JSON schema 渲染进 system prompt——schema-blind 模型也能产出合法 topic。写入验证看盘：`~/.local/share/opencode/memory/projects/<hash>/generations/*/topic-*.yaml`。

## Release notes

Releases follow `.github/RELEASE_NOTES_TEMPLATE.md`: keep section order and emoji headers, omit empty sections, fill the test summary from the CI gates, and end with the `previous_tag...current_tag` changelog link.

Mechanics（fail-closed，graphagent-v1.0.29 验证过）：

- 版本由 `packages/opencode/script/release-version.ts` 机械推导：只认 `graphagent-v*` 标签，下一个 stable 恒为 patch+1（`graphagent-v1.0.28` → `1.0.29`），dev 通道为 `X.Y.Z-dev.N`；opencode 包版本号被忽略。
- 系列文件 `.github/releases/v<推导版本>.md` 的文件名必须等于推导版本（命名错 = release job fail-closed 炸掉）；正文用 `{VERSION}`、`{Prerelease/Stable}`、`{branch}`、`{previous_tag}`、`{current_tag}` 占位符，由 `packages/opencode/script/release-notes.ts` 渲染并校验不变量。
- 本地演练渲染：`bun run ./packages/opencode/script/release-notes.ts --notes-dir .github/releases --version <V> --channel main --branch main --tag graphagent-v<V> --previous-tag graphagent-v<P> --repo LeXwDeX/OpenCode-GraphAgent --out /tmp/notes.md`

## Agent skills

### Issue tracker

Issues and PRDs are tracked in this repository's GitHub Issues through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a multi-context domain-document layout rooted at `CONTEXT-MAP.md`. See `docs/agents/domain.md`.

### SpecGit harness local specializations

Kept outside the managed block so routine bootstrap preserves the reviewed harness. The 1.13.1 refresh in #552 replaces the former 1.10.1 workarounds:

- Use the generated event-SHA checkout and branch-restoration steps together: the verdict evaluates the triggering commit while SpecGit sees the delivery branch. The generated dispatch path supplies its own ref and SHA.
- Install the pinned CLI under the generated isolated prefix, outside this Bun workspace, and use its bundled YAML parser. This avoids the workspace `catalog:` installation failure and root-package resolution assumptions. Keep the generated Node version with that CLI.
- Preserve the repository's 45-minute job timeout and 40-minute sibling-check deadline. The inner deadline stays below the job timeout so slow or missing checks produce a verdict diagnosis. This is the remaining template deviation; the bootstrap wrapper restores it after transient initialization.
- Read check identities and automation choices from `spec_git/policy.yaml`. Keep the configured checks and current-head ownership checks intact; a harness refresh does not authorize enabling automatic merge.

#### specgit-bootstrap wrapper (canonical `specgit issue` entry, #521)

`script/specgit-bootstrap.sh <specgit issue args...>` is THE canonical way to run `specgit issue` in this repository. Bare `specgit issue` is expected to fail with `harness_stale` (exit 2) whenever the pinned CLI's harness template moves — the wrapper satisfies that gate safely: it snapshots the full init write surface to a temp dir outside the repo, runs `specgit init --force --no-protect` (hardcoded, offline), then `specgit issue "$@"` with arguments, exit status, and diagnostics passed through verbatim, and restores the specialized bytes above on success and every failure path (EXIT/INT/TERM/HUP), verifying each file byte-for-byte via `git hash-object`.

- Use the wrapper for ordinary issue bootstrap. Intentional CLI/harness upgrades are tracked changes: review the generated diff and update these specializations together, while preserving the timeout budget and policy.
- Fail-closed rejections: dirty write-surface paths (tracked/staged/untracked) → exit 2 with the offending paths listed; no SpecGit binding (`.specgit.yaml` or `spec_git/policy.yaml` missing) → exit 3; restore hash mismatch → exit 3 with the snapshot kept for forensics. Rejection paths print plain `specgit-bootstrap:` stderr lines and NEVER produce a `--json` envelope.
- The inner `.specgit.yaml` delivery record is rolled back to its pre-run bytes when the inner `specgit issue` exits nonzero (or a signal/init failure interrupts); a successful call keeps the new binding. Record-restore failure keeps the forensic snapshot and exits 3, overriding the inner exit code. Branches, commits, and remote side effects are never undone (#530).
- Managed-block guidance referencing bare `specgit issue` commands is superseded by this section for this repository. Behavior tests: `bash script/specgit-bootstrap.test.sh` (stubbed CLI, zero network; not CI-wired).

<!-- specgit:block:start -->
## SpecGit delivery harness

Managed by `specgit init`. Everything between the markers is regenerated
whenever init writes the harness (a fresh init, or `--force` when a policy
already exists); keep manual guidance outside them.

### The delivery story

- Start with `specgit issue <title-or-number>...`: it creates or reuses
  the issues, branches, opens the draft pull request pre-filled with a
  deterministic scaffold (the `Closes #n` line for every bound issue,
  then Why / What changed / Evidence / Checklist sections), and writes
  `.specgit.yaml`. Re-running resumes; it is idempotent.
- Use the issue/PR templates explicitly selected by policy. With
  `validation.bodies` or `required_sections`, prepare complete content from
  the discussion before bootstrap and supply `--body-file <path>` per new
  title and `--pr-body-file <path>`. Without body rules, built-in scaffolds
  can be filled after creation. Preserve every `Closes #n`; enabled body
  rules apply at creation and acceptance. Resume keeps existing remote bodies
  and user edits. Unselected repository templates are not silently loaded.
- A draft pull request always fails the verdict (`pr_draft`): before
  `specgit finish`, mark it ready for review — `gh pr ready <number>`
  on GitHub, `glab mr update <number> --ready` on GitLab.
- `specgit finish` is read-only: its verdict comes from real git, PR,
  and CI evidence; exit 0 means accepted. With automation enabled, the trusted
  remote workflow continues after CI without another confirmation.
  `specgit pr --merge --json` is the recovery path: it verifies the approved
  `target_branch`, fresh acceptance, and all current-head CI, then confirms
  the merge and every bound issue closure before reporting completed.
  A failed closure remains recoverable and is never reported as completed.

### Issue tags

- Follow the project's `language` for issues and PRs. Enabled `validation`
  rules check titles and labels before creation and during `finish`.
  `kind` mode requires one catalog kind and only declared extras;
  `project` mode selects only policy `tags`. Users choose rule changes with
  `specgit init --force --configure-rules`.
- Every bootstrap applies the title's `kind::<type>` member
  automatically; pass `--tags <a,b>` to choose the full set explicitly.
- Selection is pool-first: existing on-spec labels win verbatim; anything
  missing is seeded from the built-in `kind::` catalog or the policy's
  `tags:` declarations. Unknown vocabulary exits 2 naming the universe.
- Choose at most one label per axis; omit uncertain optional labels and
  keep every label required by the selected policy. Existing pool labels
  cannot override that policy —
  off-spec pool labels are reported (`tag_pool_dirty` warnings are for
  humans) and never renamed by SpecGit.

### Repair and diagnostics

- `specgit pr` repairs the pull-request binding: with no arguments it
  auto-discovers the pull request for this head branch, errors with a fix
  when none is found, and refuses with a list when several match.
- `specgit status` shows local evidence only: record, state, drift,
  origin. `specgit doctor` probes git, repository, origin, gh, and
  policy.

### The command surface

- Ten commands: `specgit init`, `specgit setup`, `specgit issue`,
  `specgit pr`, `specgit finish`, `specgit bind`, `specgit unbind`,
  `specgit status`, `specgit accept`, `specgit doctor`.
- `specgit setup` installs the agent entry points (commands for opencode,
  portable skills for other tools); `specgit bind`, `specgit unbind`,
  and `specgit accept` are automation aliases for scripts and CI.
- Automation defaults to off (`--automation no`). Only when the user personally chooses
  yes may `specgit init --automation yes --merge-target <branch>` enable it;
  ordinary `init --force` preserves that choice and target. An agent must not answer yes for the user.

### Before creating an issue, check for duplicates

- Before running `specgit issue` with a new title, search the tracker for
  similar open work: `gh issue list` with keywords from the title
  (state, labels, and search terms via `gh search issues`).
- Open and read every plausible candidate (`gh issue view <n>`) — compare
  the WHY, not just the wording.
- If a candidate covers the same WHY, continue that issue instead of
  creating a new one; if it is close but different, say how they differ.
- When unsure, ask the requester to decide between continuing the existing
  issue and creating a duplicate. The team ships one line of work per WHY,
  never two.

### Issue granularity

One issue = one independently verifiable WHY. If a deliverable cannot be
verified on its own evidence, split it before binding.

### Iron rules

- `specgit finish` exit code other than 0: never request merge. Fix the
  delivery, not the gate.
- Never weaken `spec_git/policy.yaml` to make a verdict pass.
- `--json` is the only parse surface: stdout is exactly one JSON
  document; never scrape human-readable output.

### Agent contract essentials

- **SpecGit is the default delivery workflow here.** An intended tracked
  change — a feature, a fix, a refactor, a docs change, or shared rules — is a delivery:
  work items live in this tracker as issues, never in private task
  lists or conversational checklists. The trigger is the decision to
  start: the moment the conversation settles and you begin turning
  the plan into changes, the FIRST action is
  `specgit issue <type>: <title>...` — before tracked implementation edits.
  Preparing temporary body files for bootstrap is part of this first step.
  Working without a binding is a contract violation, not a style
  choice. After bootstrap, verify each issue contains the discussed
  Why / Scope / Approach / Acceptance and fill only missing content with
  `gh issue edit` or `glab issue update`,
  then implement. Mid-conversation inventories
  ("let me list everything to do") become issues, not chat
  artifacts. Trivial replies and read-only questions need none of
  this.
- Local maintenance: installing or upgrading the CLI and running `init` /
  `setup` to refresh local configuration and entry points need no issue, PR,
  product build, or release when no product or shared-rule change is intended
  for commit. Review tracked diffs before choosing what to share; ignore rules
  are never CI exemptions. Follow the host project's verification policy for
  the actual changed inputs; documentation may itself be a product input.
  Publishing requires explicit release intent within existing user authorization;
  local maintenance and merging do not imply publication.
- `specgit finish` exit `0` means accepted. Report completed only after
  the configured target merge and every bound issue closure are confirmed.
  Never declare completion from task lists, file states, or tests alone.
  Track a failed PR with a new repair issue; repeated causes reuse an open
  repair issue and do not require abandoning the original PR.
- Use existing user authorization to complete issue bodies, the PR body
  and ready transition, CI repairs or retries, acceptance, and the authorized
  merge. When user authorization or platform permission is missing, present
  the prepared result and name the specific gap. Documentation and entry
  points do not grant permission themselves.
- Branch on exit codes, not phrasing: `1` = evidence complete, fix what
  the gates named; `3` = evidence missing, fix the environment first
  (`specgit doctor`). Never present exit `3` as success.
- Keep the `Closes #n` references in the PR body intact; after changing
  the PR body, head branch, or CI, re-run `specgit finish`. Never
  bypass or reconfig a required check to make acceptance pass.
- Forge evidence flows through the user's authenticated CLI session only
  (`gh` / `glab`): never read, log, or pass around tokens.
<!-- specgit:block:end -->

## Tool-call discipline (hard rules)

- Never fan out duplicate or near-duplicate queries. One question, one
  tool call; if the answer is already in context, make zero calls.
- Parallel tool batches must contain distinct, independently justified
  calls. Before sending a batch, verify no two calls answer the same
  question. A repeated identical call is a bug regardless of intent.
- Long CI waits use `sleep N && <single check>`, never repeated watches
  of the same resource. One watch command, one result.
