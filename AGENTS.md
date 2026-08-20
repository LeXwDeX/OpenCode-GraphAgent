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
| `{type}/**` | ✅ 允许 | — | ❌ 不跑 | 开发分支，频繁变更 |
| `dev` | ❌ 禁止 | PR 必须通过 **Typecheck + Unit Tests (linux)** | ✅ push 触发 Typecheck + 全量测试 | 快速集成层 |
| `main` | ❌ 禁止 | PR 必须通过 **Typecheck + Unit Tests + E2E (linux + windows)** | ✅ push 触发全量 | 正式质量门禁 + 发版 |

**流程**：
1. 从 `main` 切出 `feat/**` 或 `fix/**` 分支开发
2. PR → `dev`（Typecheck + Unit Tests (linux) 门禁，快速合并）
3. push 到 `dev` 自动触发全量测试验证
4. 从 `dev` 手动 `release-fork` → 产出 **prerelease** 测试版
5. PR `dev` → `main`（全量测试门禁：Typecheck + Unit Tests + E2E）
6. 合并到 `main` 后手动 `release-fork` → 产出**正式版**

**Rulesets（GitHub Settings → Rules → Rulesets）**：
- `protect-main`：禁止直推/删除/force-push；PR 需通过 4 项检查（Typecheck、Unit Tests (linux)、E2E Tests (linux)、E2E Tests (windows)）
- `protect-dev`：禁止直推/删除/force-push；PR 需通过 Typecheck
- `branch-naming`：只允许创建 `feat/**`、`fix/**`、`chore/**`、`docs/**`、`refactor/**`、`test/**`、`release/**`、`hotfix/**` 前缀的新分支

**CI 配置**：
- `ci-typecheck.yml`：push 到 `main`/`dev` + PR → `main`/`dev` 时触发（快速门禁）
- `ci-test.yml`：push 到 `main`/`dev` + PR → `main` 时触发全量测试（`cancel-in-progress: false` 保证跑完）；Linux unit-tests job 额外校验生成物新鲜度（`packages/client` 与 `packages/sdk/js` 的 `check:generated`）并跑 HttpAPI 契约门禁
- `release-fork.yml`：手动触发；从 `dev` 发布自动标记 `--prerelease`，从 `main` 发布正式版

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

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.
- `bun run build` does not typecheck — esbuild transpiles only. A green build can still ship a missing import or a non-existent API, so it is not proof the code is sound. `bun typecheck` (`tsgo --noEmit`) is the commit gate.

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
- Prefer server-side aggregation for display data. The TUI renders `DagStore.getWorkflowSummaries` output verbatim; it never aggregates raw `dag.*` events client-side. Derived-view publishers (`src/dag/runtime/summary-publisher.ts`) must stay stateless: recompute from the store on every emission, no module-level caches.
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
- `dag.jsonc` supplies DAG node model tiers: `advanced` for `required: true` and review nodes, `standard` otherwise. Never pin `model` inside saved workflow specs.

## Project memory

- Memory is fail-closed inert until the project is initialized: running `/init` stamps `project.time_initialized`, which `/memory on` and `memory_search` require. `/memory on` silently answering "Memory remains off" means the project never ran `/init` (or has no real git identity).

## Release notes

Releases follow `.github/RELEASE_NOTES_TEMPLATE.md`: keep section order and emoji headers, omit empty sections, fill the test summary from the CI gates, and end with the `previous_tag...current_tag` changelog link.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in this repository's GitHub Issues through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a multi-context domain-document layout rooted at `CONTEXT-MAP.md`. See `docs/agents/domain.md`.

<!-- specgit:block:start -->
## SpecGit delivery harness

Managed by `specgit init`. Everything between the markers is rewritten on
re-init; keep manual guidance outside them.

### The delivery story

- Start with `specgit issue <title-or-number>...`: it creates or reuses
  the issues, branches, opens the draft pull request that closes every
  bound issue, and writes `.specgit.yaml`. Re-running resumes; it is
  idempotent.
- Finish with `specgit finish`: the verdict, derived from real git, PR,
  and CI evidence. Exit code 0 is the only "done".

### Repair and diagnostics

- `specgit pr` repairs the pull-request binding: with no arguments it
  auto-discovers the pull request for this head branch, errors with a fix
  when none is found, and refuses with a list when several match.
- `specgit status` shows local evidence only: record, state, drift,
  origin. `specgit doctor` probes git, repository, origin, gh, and
  policy.

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
<!-- specgit:block:end -->

## Tool-call discipline (hard rules)

- Never fan out duplicate or near-duplicate queries. One question, one
  tool call; if the answer is already in context, make zero calls.
- Parallel tool batches must contain distinct, independently justified
  calls. Before sending a batch, verify no two calls answer the same
  question. A repeated identical call is a bug regardless of intent.
- Long CI waits use `sleep N && <single check>`, never repeated watches
  of the same resource. One watch command, one result.
