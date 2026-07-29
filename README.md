<p align="center">
  <a href="./README.md"><b>English</b></a> ·
  <a href="./README.zh.md">简体中文</a>
</p>

# OpenCode-GraphAgent

> A fork of [opencode](https://github.com/anomalyco/opencode) that adds a DAG workflow engine: the coding agent decomposes a task into a dependency graph of child agents and drives it to completion. State is durable, crashes are recoverable, and the whole thing can be inspected and controlled from the terminal.

Built on top of the MIT-licensed [opencode](https://github.com/anomalyco/opencode) terminal AI agent. **Not affiliated with or endorsed by the OpenCode team.**

---

## Why a DAG

A single agent loop struggles once a task has staged dependencies, parallelizable independent work, or a quality gate in the middle. Four judgments shaped this engine:

1. **Split decisions from volume.** Work that must be correct (decomposition, gates, arbitration, final synthesis) runs on an advanced model tier; volume work (exploration, implementation, per-angle analysis) fans out on a standard tier. The standard tier buys accuracy with redundancy: breadth means independent parallel slices fanning into one arbiter, depth means claims get re-verified against code and tests across waves.
2. **Ask before building the graph.** Complex work (`deep` mode) goes through a bounded Q&A pass first (1, 3, or 5 rounds), producing a versioned, fingerprinted Requirement Brief with a `READY` / `NOT_READY` / `WAIVED` verdict. If the question budget runs out with blockers still open, the verdict is `NOT_READY`. There is no silent pass.
3. **Gate verdicts need a follow-up.** When a checkpoint returns `REVISE` / `REJECT` / `BLOCKED`, the parent agent has to dispose of it in the same wake turn: extend, replan, start a new workflow, or stop with stated reasons. Summarizing the verdict and ending the turn counts as an orchestration failure under the contract.
4. **Recover from evidence, not guesses.** Every state change is a durable event, transitions go through a declared state machine's guards, terminal states are irreversible (one exception, written into the spec), and the read model is a CQRS projection. After a crash, recovery reconciles from durable evidence and never fabricates provider work.

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
| `model` | Optional per-node model pin; otherwise resolves node → `node_defaults` → agent → `dag.jsonc` tier → parent session |
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

### Configuration

`dag.jsonc` (project `.opencode/` overrides global config dir; a commented default is seeded on first use) sets two model tiers: `advanced` for critical nodes (`required: true`, review workers), `standard` for everything else, plus a `thinking_depth` reasoning variant for child sessions. Everything else inherits the main opencode configuration.

---

## Other changes in this fork

- **Hooks API**: Claude Code hooks protocol compatibility. 26 hook events (`PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate`, …) × 5 execution types (`command`, `mcp`, `http`, `prompt`, `agent`), loaded from a global/project/worktree `hooks.json` chain or registered per-session over HTTP, with optional workspace-trust gating. See the [hooks reference](./packages/core/src/plugin/skill/configure-hooks.md).
- **Tool robustness**: JSON repair for broken multi-byte Unicode escapes in LLM output, structured validation errors with field-level hints, expanded tool docs, child-process pipe fixes.
- **CJK & IME fixes**: corrections for Chinese/Japanese/Korean input in the terminal UI (IME composition flushing, full-width text handling), plus a Korean IME fix script under [`patches/`](./patches).
- **Worktree isolation**: per-workflow `git worktree` isolation, with experimental sandbox-worktree HTTP endpoints.
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

- **CI**: typecheck on every PR; the `main` gate additionally runs the full unit suite (Linux), Playwright e2e (Linux + Windows), an HTTP API contract exerciser, and generated-SDK freshness checks.
- **DAG-specific tests**: core scheduling unit tests, projector/state-machine drift tests, workflow lifecycle integration tests, and HTTP API exercise scenarios for every DAG route.
- **Specs**: engine behavior is pinned by [openspec](./openspec/specs) specifications (execution engine, state-machine enforcement, scheduler recovery, step semantics, structured output, replay idempotency, and more).

## License

Mixed license model:

| Content | License | Text |
|---------|---------|------|
| Upstream opencode code (the vast majority) | MIT | [`LICENSE`](./LICENSE) |
| DAG workflow engine (fork-authored) | AGPL-3.0-or-later | [`packages/core/src/dag/LICENSE`](./packages/core/src/dag/LICENSE), [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Exact file boundaries are listed in [`NOTICE`](./NOTICE). The AGPL covers the DAG engine and derivatives of it, including network-server deployments. If you don't touch the DAG engine, the rest of the repository is plain MIT.

## Docs

- [`docs/harness-dag.md`](./docs/harness-dag.md) — deep-mode admission & review lifecycle
- [`openspec/specs`](./openspec/specs) — engine behavior specifications
- [`.opencode/dag-prompts`](./.opencode/dag-prompts) — built-in node prompt templates
- [`AGENTS.md`](./AGENTS.md) — contribution & development guide

## Links

- [GitHub](https://github.com/LeXwDeX/OpenCode-GraphAgent) · [Issues](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues)
- [Upstream opencode](https://opencode.ai)
