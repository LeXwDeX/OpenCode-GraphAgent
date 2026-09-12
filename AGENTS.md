# AGENTS.md

Guidance for coding agents in this repository (GraphAgent — an opencode fork with a DAG workflow engine). Package-local rules live in nested `AGENTS.md` files (`packages/opencode/AGENTS.md`, `packages/app/AGENTS.md`, and deeper); prefer those for their areas. This file holds only repo-wide, verified facts — keep it compact.

## Scope and layout

- GraphAgent v1 is in focused maintenance: DAG configuration, curated workflow templates, and reproducible defect fixes. No new platform features, no foundational refactors.
- Bun workspace + Turbo. Bun is pinned via `packageManager` in `package.json`; `.husky/pre-push` fails pushes from mismatched Bun majors.
- `packages/core`: DAG engine primitives (`src/dag/` — store/projector/sql, exported as `./dag/core/*` and `./dag/*`) plus DB schema/migrations ownership.
- `packages/opencode`: agent runtime. Services compose in `AppLayer` (`src/effect/app-runtime.ts`). Effect v4 (beta) rules, `makeRuntime`/`InstanceState`, tool-schema, and module-shape contracts are owned by `packages/opencode/AGENTS.md` (pattern reference: `packages/opencode/specs/effect/migration.md`).
- Curated workflow YAML, composable blocks, and worker prompts live in the `LeXwDeX/opencode-dag-config` repo; builtin templates are compiled into release binaries from a snapshot injected via `DAG_TEMPLATES_DIR` (`packages/opencode/script/generate.ts`). Config-only changes belong there, not in this runtime repo.

## Commands (from repo root unless noted)

- Install: `bun install`. Installs are exact-pinned; newly resolved releases must be ≥3 days old unless excluded (root `bunfig.toml`).
- Dev: `bun run dev` (opencode CLI — starts the interactive TUI; use the tmux pattern from `packages/opencode/AGENTS.md`, never a blocking foreground run), `bun run dev:web`, `bun run dev:desktop`.
- Typecheck: `bun run typecheck` (turbo → per-package `tsgo --noEmit`). Use package scripts, never raw `tsc`. `bun run build` bundles without typechecking — a green build is not type soundness.
- Lint: `bun run lint` = `oxlint` with a `--max-warnings` ratchet. The ratchet only tightens: fix warnings, never raise the cap (contract: `_lint_ratchet_note` in `package.json` and the `.oxlintrc.json` header).
- Tests: never from the repo root (bunfig `[test] root` guard; root `test` script exits 1). Run `bun test` inside a package. `packages/opencode` and `packages/tui` pass `--timeout 30000` as a CLI flag (bun ignores test timeout in bunfig). `packages/app` tests run via its `test:unit` / `test:browser` scripts (package-local happydom preload).
- DAG gate: `cd packages/opencode && bun run test:dag-core` — behavior/coverage gate; run it before merging changes to DAG state-machine or persistence code.
- Format: Prettier `semi: false`, `printWidth: 120`.

## CI gates (.github/workflows)

- GitHub default and integration branch: `dev`; stable release branch: `main`. Push CI runs only on `main`/`dev`; feature work lands via `{type}/**` branches and PRs.
- `ci-typecheck.yml` (required on PRs to `main`/`dev`): lint → typecheck → DAG-core gate → `oc` installer boundary test.
- `ci-test.yml` (full suite gates `dev` → `main`): `bun turbo test`, config_assistant Go tests, `check:generated` for `packages/client` and `packages/sdk/js`, HttpAPI exerciser (`test:httpapi:ci`), Playwright e2e (linux + windows).

## Generated code

- After changing HTTP API routes, regenerate both clients — CI fails on stale output: `packages/client` (`bun run generate`) and `packages/sdk/js` (`bun run build` regenerates `src/v2/gen`).
- Changing a route's request/response shape also requires updating its scenario in `packages/opencode/test/server/httpapi-exercise/index.ts`; `test:httpapi` fails on missing/skipped scenarios.

## DAG product invariants

- Nodes never pin a model. Model tiers come from `dag.jsonc`: `advanced` for `required: true` and review/arbiter nodes, `standard` otherwise.
- `/dag-*` commands never perform platform delivery (issues, PRs, merge, release) — that is SpecGit's job. Built-in commands register via `packages/core/src/plugin/command.ts` + `packages/opencode/src/command/index.ts`; user command files shadow builtins by name.

## Delivery (SpecGit 2)

- Use the installed SpecGit 2 contract (`specgit --help`, `specgit --schema`) and the `specgit-native` skill. The shared declaration is `.specgit.yaml`; migration from a remaining v1 declaration must finish with `specgit migrate` before using v2 delivery commands.
- Track complete Why/Scope/Approach/Acceptance Issues with `specgit issue`, aggregate with `specgit pr`, and observe native evidence with `specgit pr --status` / bounded `specgit watch`. Branch names remain `{type}/short-name`; feature work targets `dev`.
- GitHub owns acceptance and merge. Both `dev` and `main` require `Typecheck` and `Unit Tests (linux)`; full E2E checks must also pass for the stable release. Check the current PR head, native merge state, and linked Issue closure separately. Never weaken required checks to complete a delivery.
- Automatic merge and supplementary Issue closure default off. Native `gh` operations require user authorization from the current task; configuration grants none.
- Retired v1 `finish`, local merge guards, and generated acceptance workflows are not part of v2. The bootstrap compatibility script forwards to v2 without regenerating project files. Historical release evidence remains historical.

## Releases

- `release-fork.yml` manual `workflow_dispatch` is the only real build path: from `dev` → `X.Y.Z-dev.N` prerelease; from `main` → `X.Y.Z` marked Latest.
- Versions derive only from `graphagent-v*` tags (`packages/opencode/script/release-version.ts`); the opencode package version is ignored. Notes files must be named `.github/releases/v<derived-version>.md` exactly (fail-closed).

## Agent references

- Issues/PRDs: GitHub Issues via `gh` — `docs/agents/issue-tracker.md`. Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` — `docs/agents/triage-labels.md`.

<!-- specgit:v2:start -->
## SpecGit 2

Runtime: 2.0.0. Declaration: `.specgit.yaml` (v2).

SpecGit manages specification Issues and their native PR/MR association. Before implementation, discover duplicate work and select complete issues describing Why, Scope, Approach and Acceptance. Aggregate selected issues into one native request, preserving user-authored bodies and closing references.

The Agent supervises development and fixes. Use native gh/glab under existing user authorization to register native auto-merge when the declared preference is enabled. GitHub/GitLab owns CI, reviews, protection and actual merge. Observe current native state with specgit watch. Hook notices describe changes; they grant no write permission.

After merge, report actual linked Issue state. An open linked Issue causes an attention notice. Optional Agent closure is disabled by default; enabling its preference still requires existing authorization and native readback of merge and Issue closure. Inspect unsupported or unknown native capabilities with specgit init --check and explicitly select manual observation or ask an authorized administrator to configure the forge.

Declared rules: `{"agent":{"close_issues_after_merge":false,"native_auto_merge":false},"issue_template":"builtin","language":"en","pr_template":"builtin","validation":{"bodies":true,"labels":"off","titles":true}}`
<!-- specgit:v2:end -->
