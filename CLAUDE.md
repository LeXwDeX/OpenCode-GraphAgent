# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**OpenCode-GraphAgent** (product name "GraphAgent"): a fork of the MIT-licensed
[opencode](https://github.com/anomalyco/opencode) terminal AI agent that adds a
**DAG workflow engine** for multi-agent orchestration. A task is decomposed into a
dependency graph of child-agent sessions, driven to completion with durable,
crash-recoverable, inspectable state. Upstream opencode capabilities (multi-provider
LLM, built-in LSP, TUI/desktop/web clients, client/server architecture) are preserved.

**`AGENTS.md` is the canonical contributor guide.** It holds the full style guide,
git workflow (铁律), and二次开发 (extending) invariants. Read it for *how* to write
code here; this file covers the *what* and the big-picture architecture, and does not
repeat AGENTS.md. Default branch is `main`.

## Commands

Requirements: **Bun 1.3+** (`packageManager: bun@1.3.14`). All commands run from repo
root unless noted.

```bash
bun install                              # install (postinstall fixes node-pty)

# Run the app (bun dev == local equivalent of the built `opencode` CLI)
bun dev                                  # TUI, in packages/opencode by default
bun dev <directory>                      # TUI against another dir (`bun dev .` for repo root)
bun dev serve                            # headless HTTP API server (default port 4096)
bun dev serve --port 8080                # custom port
bun dev web                              # server + web UI
bun run --cwd packages/app dev           # web app dev server (needs `bun dev serve` running)
bun run --cwd packages/desktop dev       # Electron desktop app

# Quality gates
bun typecheck                            # turbo typecheck across all packages (the commit gate)
bun typecheck                            # also runnable from a package dir, e.g. packages/opencode
bun lint                                 # oxlint, ratcheted: --max-warnings=4852 (see below)

# Tests — NEVER run from repo root (guard: do-not-run-tests-from-root; bunfig enforces it)
cd packages/opencode && bun test                                  # full suite (only-failures shown)
cd packages/opencode && bun test path/to/file.test.ts            # one file
cd packages/opencode && bun test --test-name-pattern "pattern"   # filtered tests
cd packages/opencode && bun run test:dag-core                    # DAG scheduling/state-machine coverage gate
cd packages/opencode && bun run test:httpapi                     # HTTP API contract exerciser (3 modes)

# Build & codegen
./packages/opencode/script/build.ts --single   # standalone binary → packages/opencode/dist/<platform>/bin/opencode
./packages/sdk/js/script/build.ts              # regenerate the JS SDK from the OpenAPI spec (after HTTP route changes)
bun run generate                               # root: regen SDK + openapi.json + format (wrapper of the above)
```

**`bun typecheck` (`tsgo --noEmit`) is the real gate.** `bun run build` uses esbuild
and transpiles only — a green build can still ship a missing import or non-existent API.
Never invoke `tsc` directly.

**Lint ratchet:** `bun lint` runs `oxlint --max-warnings=4852`. The threshold only ever
tightens — new warnings fail CI and the pre-commit hook. When you fix existing warnings,
lower the number in the root `package.json` `lint` script to match (rationale recorded in
the `_lint_ratchet_note` field there). `oxlint` is `typeAware: true`.

Pre-commit (husky) runs `lint` + `typecheck`. `post-checkout`/`pre-push` hooks also exist.

## Architecture

### Monorepo layout (Bun workspaces + Turborepo)

`packages/core` (`@opencode-ai/core`) is the framework layer: pure domain logic, the
plugin/SDK, schema, storage, event system, and the **pure half of the DAG engine**.
`packages/opencode` (`opencode`) is the application: the CLI/server entrypoint, session
runtime, HTTP server, and the **execution half of the DAG engine**. `core` has no
dependency on `opencode`; the arrow points the other way.

Key packages:

| Package | Role |
|---|---|
| `packages/core` | Domain primitives, storage, schema, events, **pure DAG state machine/projector/store** |
| `packages/opencode` | CLI + headless server, session runtime, **DAG execution/loop/spawn/admission/recovery** |
| `packages/tui` | Terminal UI (SolidJS + opentui), incl. the DAG inspector (`src/feature-plugins/system/dag-inspector.tsx`) |
| `packages/app` · `packages/web` · `packages/desktop` | Web components / web app / Electron wrapper |
| `packages/sdk/js` | `@opencode-ai/sdk` — **generated** from the server's OpenAPI spec (`src/v2/gen`) |
| `packages/plugin` · `packages/schema` · `packages/protocol` · `packages/client` | Plugin SDK, event/schema definitions, wire protocol, server client |

### The DAG engine is split across two packages (the non-obvious part)

The workflow engine is the fork's reason for existing. It is deliberately divided:

- **`packages/core/src/dag`** — *pure, side-effect-free*: declared state-machine transition
  tables (`core/transitions.ts`), dependency graph + cycle/dangling validation
  (`core/graph.ts`), wave-based scheduler (`core/scheduling.ts`), replan fragment merge
  (`core/replan.ts`), and the **event projector** (`projector.ts`) that writes the SQLite
  read model *inside* the event-publish transaction. History is event replay, not a log
  table. `store.ts` / `sql.ts` are the persistence boundary.
- **`packages/opencode/src/dag`** — *effectful execution*: the workflow service (`dag.ts`,
  `workflows.ts`), the execution loop (`runtime/loop.ts`), spawning real child sessions per
  node (`runtime/spawn.ts`, same path as the `task` tool), deep-mode admission Q&A
  (`admission.ts`), the `design`/`diff` review lifecycle with implementation-fingerprint
  contracts (`review-lifecycle.ts`), lazy evidence-based crash recovery
  (`runtime/recovery.ts`), and prompt-template resolution (`templates/`).

A node never names its own model — the graph declares which nodes are *critical* and
`.opencode/dag.jsonc` decides what model runs each tier (`advanced` / `standard`).
Agents drive workflows through a single `workflow` tool; humans observe/control via the
TUI DAG inspector or the `GET/POST /dag*` HTTP routes.

### Effect-TS is the composition backbone

The codebase is built on `effect` 4.0.0-beta. Services are `Context.Tag`s wired through
`Layer`s. Two parallel composition systems coexist and **do not share wiring**:

1. `X.defaultLayer` / `AppLayer` — the primary Effect layer graph.
2. `LayerNode` (`.node` exports, `LayerNode.buildLayer`) — a separate node-based system.

Both demand **self-contained layers**: a `defaultLayer` must `Layer.provide` every
dependency its body `yield*`s. `Layer.provideMerge(self, layer)` builds `layer` in
isolation, and `Layer.mergeAll` does not cross-provide siblings — so a layer that quietly
assumes an ambient service will compile clean and crash at runtime in a different entry
point. Optional/heavyweight cross-deps (Provider, MCP, HttpClient) are resolved lazily via
`Effect.serviceOption(Tag)` at the call site. See AGENTS.md "Extending the Codebase" for
the full invariant list — the build will not catch violations of these.

### Configuration & data files (all under `.opencode/`)

| Path | Purpose |
|---|---|
| `.opencode/dag.jsonc` | Model tiers + `thinking_depth` for DAG child sessions (global counterpart in opencode config dir) |
| `.opencode/workflows/*.yaml` | Project-local saved workflow specs; curated workflows live in the config repository |
| `.opencode/dag-prompts/*.md` | Project-local node prompt templates referenced by `prompt_template.id` |
| `.opencode/command/*.md` | Custom slash commands (`commit`, `issues`, `changelog`, `translate`, `learn`, …) |
| `.opencode/opencode.jsonc` | Main app config |

Curated *global* workflows live in a separate repo, [`LeXwDeX/opencode-dag-config`](https://github.com/LeXwDeX/opencode-dag-config); config-only changes belong there, not here. `dag.jsonc` and the workflow library are read lazily — edits apply to the next workflow start without a restart.

### Spec-driven & domain docs

- **`openspec/`** — spec-driven change proposals. `openspec/changes/<id>/` holds
  `proposal.md` / `design.md` / `tasks.md` / `specs/`; `openspec/specs/` holds the
  established capability specs. Active proposals (e.g. `harden-goal-state-machine`,
  `internalize-dag-block-capabilities`) define in-flight work.
- **`CONTEXT-MAP.md` → `CONTEXT.md`** — multi-context domain docs. `CONTEXT-MAP.md` is the
  index; read the linked `CONTEXT.md`(s) relevant to the area before working in it.
- **`docs/agents/`** — issue-tracker workflow, triage labels, domain-doc conventions.

## Critical, non-obvious rules

These compile clean but bite at runtime or in CI — the build will not catch them:

- **Regenerate the SDK after touching any HTTP API route.** `packages/sdk/js` is generated
  from the server's OpenAPI spec; a stale SDK breaks the TUI at runtime (calling a client
  method that doesn't exist) in a way typecheck can't catch. After route changes run
  `./packages/sdk/js/script/build.ts`. CI's `Check generated SDK` step
  (`bun run check:generated` = regen + `git diff --exit-code -- src/v2/gen`) enforces this.
- **Changing an HTTP route's request/response shape** requires updating its scenario in
  `test/server/httpapi-exercise/index.ts`; `bun run test:httpapi --fail-on-missing` fails otherwise.
- **Don't hand-duplicate SDK types in TUI/plugin code** — re-export the generated type so a
  server schema change surfaces as a typecheck error instead of silent drift.
- **Every event type the TUI consumes** must be `define()`d in `packages/schema` and listed
  in `Event manifest.Definitions`, or the generated event union won't contain it. Ephemeral
  push events (e.g. `dag.workflow.summary.updated`) stay OUT of the durable manifest — emit
  via `GlobalBus`, never persist, design consumers to tolerate missed events (re-fetch on bootstrap).
- **Adding a service other services see:** find every consumer's `.node` list (not just its
  `defaultLayer`) and add the new service's node there. A missing wire compiles clean and
  fails silently (feature no-ops) rather than erroring.
- **Mixed license:** upstream code is MIT; the DAG engine
  (`packages/core/src/dag/**`, `packages/opencode/src/dag/**`) is AGPL-3.0-or-later. Exact
  boundaries are in `NOTICE`. Don't move AGPL code into MIT-licensed paths or vice versa.

## Git workflow (summary — full rules in AGENTS.md)

`feat/fix` branches → PR (Typecheck gate) → `dev` (fast integration, push runs full tests) →
PR (full gate: Typecheck + Unit + E2E on linux+windows) → `main` → manual release. Direct
pushes to `main`/`dev` are blocked by GitHub Rulesets. Branch names: `{type}/{short-name}`
(`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `release`, `hotfix`), enforced by
Ruleset. Commits/PR titles: conventional `type(scope): summary`. All PRs must reference an
existing issue (`Fixes #N`). Curated DAG configs are owned by the `opencode-dag-config` repo.

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
- Issue bodies are filled at bootstrap, from the conversation: right after
  `specgit issue` succeeds, edit each issue it created (`gh issue edit <n>`)
  with the discussed Why / Scope / Approach / Acceptance, then implement.
  The PR scaffold's placeholders are advisory — fill those sections in as
  you deliver; the closing references are the only body gate. The PR body
  is written once at creation; no SpecGit command edits an existing PR
  body, and the repository's own pull-request template is never read.
- A draft pull request always fails the verdict (`pr_draft`): before
  `specgit finish`, mark it ready for review — `gh pr ready <number>`
  on GitHub, `glab mr update <number> --ready` on GitLab.
- Finish with `specgit finish`: the verdict, derived from real git, PR,
  and CI evidence. Exit code 0 is the only "done".

### Issue tags

- Every bootstrap applies the title's `kind::<type>` member
  automatically; pass `--tags <a,b>` to choose the full set explicitly.
- Selection is pool-first: existing on-spec labels win verbatim; anything
  missing is seeded from the built-in `kind::` catalog or the policy's
  `tags:` declarations. Unknown vocabulary exits 2 naming the universe.
- Choose with restraint: at most one label per axis, none when unsure —
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

- **SpecGit is the default way of working here.** Any non-trivial
  task — a feature, a fix, a refactor, a docs change — is a delivery:
  work items live in this tracker as issues, never in private task
  lists or conversational checklists. The trigger is the decision to
  start: the moment the conversation settles and you begin turning
  the plan into changes, the FIRST action is
  `specgit issue <type>: <title>...` — before any file edit.
  Working without a binding is a contract violation, not a style
  choice. Immediately after bootstrap, fill each issue body
  (Why / Scope / Approach / Acceptance) from the discussion with
  `gh issue edit`, then implement. Mid-conversation inventories
  ("let me list everything to do") become issues, not chat
  artifacts. Trivial replies and read-only questions need none of
  this.
- The one rule: a delivery is done if and only if `specgit finish`
  exits `0`. Never declare completion from task lists, file states, or
  test runs you performed yourself.
- Branch on exit codes, not phrasing: `1` = evidence complete, fix what
  the gates named; `3` = evidence missing, fix the environment first
  (`specgit doctor`). Never present exit `3` as success.
- Keep the `Closes #n` references in the PR body intact; after changing
  the PR body, head branch, or CI, re-run `specgit finish`. Never
  bypass or reconfig a required check to make acceptance pass.
- Forge evidence flows through the user's authenticated CLI session only
  (`gh` / `glab`): never read, log, or pass around tokens.
<!-- specgit:block:end -->
