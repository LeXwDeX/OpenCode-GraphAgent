<p align="center">
  <a href="./README.md"><b>English</b></a> ·
  <a href="./README.zh.md">简体中文</a>
</p>

# GraphAgent

> A coding agent that decomposes a task into a dependency graph of child agents and drives it to completion. State is durable, crashes are recoverable, and the whole graph can be inspected and controlled from the terminal.

GraphAgent is the product name for this project; the repository is published as
**OpenCode-GraphAgent**, a fork of the MIT-licensed
[opencode](https://github.com/anomalyco/opencode) terminal AI agent that adds
the DAG workflow engine. **Not affiliated with or endorsed by the OpenCode
team.**

---

## Graph engineering, before it had a name

GraphAgent treats a graph as an **executable, durable, inspectable contract** — not a diagram of agents and not a prompt chain with arrows added afterward. The public history landed the first complete DAG-engine commit on **2026-07-02**. The paper [*What makes prompts a graph: necessary and sufficient conditions for prompt graph engineering*](https://arxiv.org/abs/2607.27578), which formalized explicit structure, prompt/topology separation, executable semantics, and the graph as a first-class artifact, appeared on **2026-07-30**. The implementation was already running four weeks before the vocabulary caught up.

Our graph-engineering doctrine is operational:

1. **Edges must carry work.** A dependency exists only when the downstream node consumes the upstream artifact. Delete ceremonial sequencing and run truly independent work in parallel.
2. **A template is a reference topology, not a cage.** The parent agent may expand or prune lanes to match the task, but every prune records its reason and replacement coverage.
3. **Prediction, verification, and merge have different owners.** A `reasoner` simulates likely execution paths, a fresh-context reviewer checks the preceding local wave, and exactly one arbiter owns the verdict. These gates cannot be pruned.
4. **Iteration is a bounded local graph rewrite.** `PASS` finalizes, `LOOP` adds a new correction/review wave through pause → replan → resume, and `BLOCKED` stops with evidence. Completed nodes never form a hidden cycle.
5. **Reality outranks self-report.** State is event-sourced, recovery follows durable evidence, tests and code settle claims, and humans retain pause/step/cancel/replan authority where mistakes are expensive.

The repository ships three opinionated reference graphs: design decision deep-dive, parallel project delivery, and deep review of an existing subsystem. `/dag-flow` selects the closest shape from the request, injects the current task, and derives the actual DAG while preserving its fail-closed gates. See the [Graph Engineering workflow catalog](./.opencode/workflows/GRAPH-ENGINEERING.md).

## Why a DAG

A single agent loop struggles once a task has staged dependencies, parallelizable independent work, or a quality gate in the middle. Four judgments shaped this engine:

1. **Split decisions from volume.** Work that must be correct (decomposition, gates, arbitration, final synthesis) runs on an advanced model tier; volume work (exploration, implementation, per-angle analysis) fans out on a standard tier. The standard tier buys accuracy with redundancy: breadth means independent parallel slices fanning into one arbiter, depth means claims get re-verified against code and tests across waves.
2. **Ask before building the graph.** Complex work (`deep` mode) goes through a bounded Q&A pass first (1, 3, or 5 rounds), producing a versioned, fingerprinted Requirement Brief with a `READY` / `NOT_READY` / `WAIVED` verdict. If the question budget runs out with blockers still open, the verdict is `NOT_READY`. There is no silent pass.
3. **Gate verdicts need a follow-up.** When a checkpoint returns `REVISE` / `REJECT` / `BLOCKED`, the parent agent has to dispose of it in the same wake turn: extend, replan, start a new workflow, or stop with stated reasons. Summarizing the verdict and ending the turn counts as an orchestration failure under the contract.
4. **Recover from evidence, not guesses.** Every state change is a durable event, transitions go through a declared state machine's guards, terminal states are irreversible (one exception, written into the spec), and the read model is a CQRS projection. After a crash, recovery reconciles from durable evidence and never fabricates provider work.

## Using workflows

Nothing has to be configured to try it: ask for work that has stages, parallel
parts, or a review gate in the middle, and the agent designs a graph and runs
it. Three things turn that into a repeatable setup of your own.

### 1. Choose the model tiers — `.opencode/dag.jsonc`

Nodes never name their own model. The graph declares *which nodes are critical*
and configuration decides *what runs them*:

```jsonc
{
  // Critical nodes: required: true, plus review/arbiter workers.
  "model": {
    "advanced": "anthropic/claude-sonnet-4-5",
    "standard": "anthropic/claude-haiku-4-5"
  },
  // Reasoning variant for DAG child sessions, when the model defines one.
  "thinking_depth": "medium"
}
```

A project `.opencode/dag.jsonc` overrides the global one in the opencode config
dir; a commented default is seeded there on first use. With only one tier
configured, it serves as the unified default. Resolution order per node is
tier → worker agent model → parent session model; when none of them yields a
model, the workflow is not created and you are asked to configure one.

### 2. Save the workflows you rerun — `.opencode/workflows/`

A workflow spec is a YAML file describing the graph. Put it in a workflow
directory and it gains a **name**:

| Scope | Path | Availability |
|---|---|---|
| Project | `.opencode/workflows/<name>.yaml` | This repo, committed with it — the whole team gets the same procedure |
| Global | `<opencode config dir>/workflows/<name>.yaml` | Every project on the machine |

The filename stem is the name, and a project file shadows a global one with the
same name. A minimal spec:

```yaml
title: Dependency audit
config:
  name: dependency-audit
  nodes:
    - id: inventory
      name: inventory
      worker_type: explore
      depends_on: []
      required: true
      prompt_template:
        id: config-explore
        input:
          target: "package.json files and lockfiles"

    - id: report
      name: report
      worker_type: general
      depends_on: [inventory]
      report_to_parent: true
      prompt_template:
        inline: "Flag outdated or duplicated dependencies in {{inventory}} and propose an upgrade order."
```

Then just say "run the dependency-audit workflow" — the agent starts it by
name, no path needed. Ad-hoc specs still work exactly as before: a `spec_path`
that looks like a path (has a separator or a `.yaml`/`.yml` extension) is read
relative to the session directory instead of the library.

### 3. Let the agent author it

The built-in **`create-dag-workflow`** skill covers spec authoring: the two
scopes, the file shape, the rules a saved spec must respect (no pinned models,
`worker_type` must exist, required template variables must be supplied), and
how to verify it. Ask to "save this as a reusable workflow" and the agent
establishes the phases and gates with you, writes the file into the scope you
pick, and proves it by starting it once.

Node prompts come from `.opencode/dag-prompts/*.md` — 12 templates ship
in-repo, referenced by `prompt_template.id`. Add your own `.md` file there to
make a new template available; a global workflow should prefer `inline` prompts
so it does not depend on a repo-local template.

## DAG workflow engine

The engine lives in [`packages/core/src/dag`](./packages/core/src/dag) (state machine, dependency graph, scheduling, event projection, SQLite read model) and [`packages/opencode/src/dag`](./packages/opencode/src/dag) (workflow service, execution loop, node spawn, admission, review lifecycle, crash recovery, templates). Agents drive it through a single `workflow` tool; humans watch and control it through the TUI or HTTP API.

### Graph definition

Each node declares:

| Field | Purpose |
|---|---|
| `depends_on` | Dependency edges; cycle detection and dangling-reference validation at creation |
| `worker_type` | Which agent runs the node (`explore`, `build`, `general`, or any configured agent) |
| `prompt_template` | Prompt by `id` (from `.opencode/dag-prompts/`, 12 templates ship in-repo) or `inline`, with `{{var}}` interpolation |
| `input_mapping` | Map upstream node outputs into template variables (`"count": "node-b.output.count"`) |
| `condition` | Expression over upstream outputs; false → node skipped, pure descendants cascade-skip |
| `output_schema` | JSON Schema; the child agent must call `submit_result` with a matching structured payload |
| `required` | Failure of a required node fails the workflow |
| `report_to_parent` | Wake the parent agent when this node reaches a terminal state |
| `review` | `design` or `diff` review phase with an implementation-fingerprint contract (below) |

Workflow-level knobs: `max_concurrency` (default 5), `max_node_replan_attempts` (5), `max_total_nodes` (100), per-node `timeout_ms` (default 10 min, queue wait counts toward the deadline).

### Scheduling & execution

- Nodes spawn as real child sessions through the same code path as the `task` tool, wave by wave in dependency order, bounded by a concurrency semaphore. A node is durably `queued` at admission and the child session only materializes inside the permit, so a 100-node fan-out never creates 100 sessions at once.
- **Dynamic replanning**, pause-first: `pause` freezes scheduling instantly, `replan` merges a fragment (add / replace / cancel / restart nodes) atomically against the live graph, `resume` continues. Terminal nodes are immutable; retrying a failed node means adding a replacement under a new id. `extend` appends nodes, and may reopen a naturally-completed workflow (the single sanctioned exception to terminal irreversibility).
- **Step mode** runs one node at a time for debugging.
- **The parent does not poll.** Synthetic messages wake it when a `report_to_parent` node or the workflow terminalizes. Checkpoint nodes emit a normalized verdict (`ACCEPT` / `REVISE` / `REJECT` / `BLOCKED`), and the disposal contract governs what happens next. Iteration is a bounded, verdict-driven replan wave; the graph never contains a cyclic edge.

### State machine & persistence

- Declared transition tables for workflow and node status; every mutation goes through a guard, invalid transitions and terminal violations are typed errors (HTTP 409, not 500).
- All changes are published as durable `dag.*` events; a projector writes the SQLite read model *inside* the publish transaction. History is event replay, not a log table. A drift test fails whenever the projector's guards and the declared transition tables are edited out of sync.
- **Crash recovery** is lazy, per-workflow, and evidence-based: nodes left `running` are reconciled against their child session's durable state. Sessions that finished back-fill their captured output; when execution ownership was genuinely lost, the workflow pauses and the parent decides disposition (replan / resume / cancel). Recovery never adopts or restarts provider work on its own.

### Deep mode: admission & review

- Admission Q&A covers six dimensions (goal, scope, constraints/assumptions, acceptance criteria, evidence, risks) under a bounded policy: `LIGHT` (1 round), `STANDARD` (3), `GRILL` (5, adversarial). The resulting Requirement Brief is fingerprinted (SHA-256 over a canonical form); material changes invalidate the fingerprint and return admission to questioning. A consumed record is persisted with the workflow and never replayed.
- Review nodes declare their phase honestly: `design` reviews pre-implementation artifacts; `diff` reviews the actual implementation and requires the implementation node, a passing verification node, and a fingerprint echo. Changing the implementation changes the fingerprint, so a stale `ACCEPT` cannot satisfy the gate.

### Observing & controlling

- **TUI DAG inspector** (command palette → `dag.open`): workflow list, wave-ordered node view with live status, node detail (deps, errors, output preview, deadline countdown), and `p`/`r`/`s`/`x` for pause/resume/step/cancel; `enter` drops into a node's child session.
- **Sidebar panel**: per-session workflow progress (completed/running/failed/queued), expandable node list, driven by ephemeral summary events, with a fetch-on-open safety net instead of polling.
- **HTTP API** (same code path as the tool surface):

  ```
  GET  /dag                              list workflows
  POST /dag                              start a workflow
  GET  /dag/session/:sessionID           workflows for a session
  GET  /dag/session/:sessionID/summary   progress summaries
  GET  /dag/:dagID                       workflow detail
  GET  /dag/:dagID/nodes                 node list
  GET  /dag/:dagID/nodes/:nodeID         node detail
  POST /dag/:dagID/control               pause/resume/cancel/replan/extend/step/complete
  ```

### Project configuration files

Everything DAG-specific lives under `.opencode/`, with a global counterpart in
the opencode config dir (`OPENCODE_CONFIG_DIR`, else `~/.config/opencode`).
Everything else inherits the main opencode configuration.

| Path | Purpose | Global counterpart |
|---|---|---|
| `.opencode/dag.jsonc` | Model tiers (`advanced` / `standard`) and `thinking_depth` for child sessions | `<config dir>/dag.jsonc`, seeded with comments on first use |
| `.opencode/workflows/*.yaml` | Saved workflow specs, startable by name | `<config dir>/workflows/*.yaml` |
| `.opencode/dag-prompts/*.md` | Node prompt templates referenced by `prompt_template.id` | — (project-scoped) |

Both `dag.jsonc` and the workflow library are read lazily, so an edit applies to
the next workflow start without a restart.

---

## Other changes in this fork

- **Hooks API**: Claude Code hooks protocol compatibility. 26 hook events (`PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate`, …) × 5 execution types (`command`, `mcp`, `http`, `prompt`, `agent`), loaded from a global/project/worktree `hooks.json` chain or registered per-session over HTTP, with optional workspace-trust gating. See the [hooks reference](./packages/core/src/plugin/skill/configure-hooks.md).
- **Tool robustness**: JSON repair for broken multi-byte Unicode escapes in LLM output, structured validation errors with field-level hints, expanded tool docs, child-process pipe fixes.
- **CJK & IME fixes**: corrections for Chinese/Japanese/Korean input in the terminal UI (IME composition flushing, full-width text handling), plus a Korean IME fix script under [`patches/`](./patches).
- **Worktree isolation**: per-workflow `git worktree` isolation, with experimental sandbox-worktree HTTP endpoints.
- **Configuration assistant**: a standalone Go TUI under [`config_assistant`](./config_assistant) for locating, validating, and editing opencode configuration (`cd config_assistant && go run ./cmd/ocfg`).
- An earlier "Goal auto-loop" and the `/goal`, `/subgoal`, `/workflow` slash commands are gone; autonomous execution now goes through the `workflow` tool and its wake mechanism.

All upstream capabilities (multi-provider, built-in LSP, client/server architecture, TUI/desktop/web clients) are preserved.

---

## Install

Prebuilt CLI binaries (Linux / macOS / Windows, with SHA256SUMS) are published on the [releases page](https://github.com/LeXwDeX/OpenCode-GraphAgent/releases). Builds from `main` are formal releases; builds from `dev` are prereleases.

From source (requires [Bun](https://bun.sh) 1.3+):

```bash
bun install
bun dev              # TUI
bun dev serve        # headless API server (port 4096)

# standalone binary
./packages/opencode/script/build.ts --single
```

> This fork is not published to npm/brew/scoop. The upstream `opencode-ai` package installs upstream opencode, not this fork.

---

## Quality gates

- **CI**: typecheck on every PR; the `main` gate additionally runs the Bun/Turbo unit suite and config-assistant Go tests (Linux), Playwright e2e (Linux + Windows), an HTTP API contract exerciser, and generated-SDK freshness checks.
- **DAG-specific tests**: core scheduling unit tests, projector/state-machine drift tests, workflow lifecycle integration tests, and HTTP API exercise scenarios for every DAG route.

## License

Mixed license model:

| Content | License | Text |
|---------|---------|------|
| Upstream opencode code (the vast majority) | MIT | [`LICENSE`](./LICENSE) |
| DAG workflow engine (fork-authored) | AGPL-3.0-or-later | [`packages/core/src/dag/LICENSE`](./packages/core/src/dag/LICENSE), [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Exact file boundaries are listed in [`NOTICE`](./NOTICE). The AGPL covers the DAG engine and derivatives of it, including network-server deployments. If you don't touch the DAG engine, the rest of the repository is plain MIT.

## Docs

- [Saved workflow authoring guide](./packages/core/src/plugin/skill/create-dag-workflow.md) — the `create-dag-workflow` skill body
- [Graph Engineering workflow catalog](./.opencode/workflows/GRAPH-ENGINEERING.md) — reference topologies and adaptation contracts
- [`docs/harness-dag.md`](./docs/harness-dag.md) — deep-mode admission & review lifecycle
- [`.opencode/workflows/change-review.yaml`](./.opencode/workflows/change-review.yaml) — compact change review, startable as `change-review`
- [`.opencode/dag-prompts`](./.opencode/dag-prompts) — built-in node prompt templates
- [`AGENTS.md`](./AGENTS.md) — contribution & development guide

## Links

- [GitHub](https://github.com/LeXwDeX/OpenCode-GraphAgent) · [Issues](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues)
- [Upstream opencode](https://opencode.ai)
