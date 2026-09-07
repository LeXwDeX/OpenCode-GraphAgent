<!--
  Built-in skill. Name and description are registered in code at
  packages/opencode/src/skill/index.ts (CONFIGURE_HOOKS_SKILL_DESCRIPTION).
  The body below becomes the skill's content.
-->

# Configuring OpenCode hooks

Hooks let you run code (shell command, MCP tool, HTTP call, LLM prompt, or an
autonomous sub-agent) automatically when specific events happen during a
session — before/after a tool call, on session start, on compaction, etc.
Config lives in dedicated `hooks.json` files (NOT `opencode.json`, NOT
`.claude/settings.json` — `.claude/` is never read for hooks).

## Where files live

| Scope    | Path                              | Hot-reloaded?                     |
| -------- | --------------------------------- | --------------------------------- |
| Global   | `~/.config/opencode/hooks.json`   | Yes — polled every ~2s            |
| Project  | `.opencode/hooks.json`            | Yes — polled every ~2s            |
| Worktree | `<worktree>/.opencode/hooks.json` | Yes (when worktree ≠ project dir) |

Layers concat-append (do NOT override by key): global hooks run, then project
hooks are appended after, in file order. A single event can have hooks from
multiple layers all firing.

If you find a `hooks` field left inside `settings.json` or `.claude/`, it is
ignored — point the user at `/import-claude-hooks` to migrate it.

## File format

Top-level keys are event names; each maps to a list of matcher blocks:

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "./scripts/check.sh", "timeout": 10 }]
    }
  ],
  "SessionStart": [
    {
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "./scripts/welcome.sh" }]
    }
  ]
}
```

`matcher` selects which tool/target the block applies to:

- `"*"` or omitted — matches everything
- `"Bash"` — exact match (case-insensitive)
- `"Bash|Edit|Write"` — pipe-separated list
- any other string — treated as a regex tested against the target

## Events (26 total)

Tool lifecycle: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`
Permission: `PermissionRequest`, `PermissionDenied`
Session lifecycle: `Setup`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`
Subagents: `SubagentStart`, `SubagentStop`
Prompt/compaction: `UserPromptSubmit`, `PreCompact`, `PostCompact`
Tasks/goals: `TaskCreated`, `TaskCompleted`
MCP elicitation: `Elicitation`, `ElicitationResult`
Other: `Notification`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`,
`InstructionsLoaded`, `CwdChanged`, `FileChanged`

Removed event: `TeammateIdle` — no teammate concept exists in opencode, so it
could never fire. Entries naming it in hooks.json are skipped with a warning
(not an error); delete them.

`Elicitation` / `ElicitationResult` fire when an MCP server issues
`elicitation/create`; the ask is mapped onto the Question UI, validated against
the requested schema, and answered accept/decline/cancel. `Notification` fires
for "agent needs attention" moments (permission asks, MCP elicitation asks)
through the internal Notification emitter; hook commands are the only external
effect today (OS/desktop delivery is a future change). A blocking `Elicitation`
hook deny short-circuits to `decline` without surfacing; unanswered elicitations
decline after 5 minutes (headless compositions decline immediately).

If you need the exact input/output shape for a specific event, read
`packages/opencode/src/hook/settings.ts` (`HookEvent`, `HookSpecificOutput`) —
this skill is a map, not the full schema.

## Hook types (all 5 implemented)

| `type`    | What it does                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------- |
| `command` | Runs a shell command. Event data is piped to stdin as JSON; stdout/exit code drive the result. |
| `mcp`     | Invokes an MCP tool, addressed as `mcp__<server>__<tool>`.                                     |
| `http`    | POSTs the event envelope to `url`; response body is parsed as JSON.                            |
| `prompt`  | Sends the event to an LLM, constrained to structured JSON output.                              |
| `agent`   | Runs an autonomous sub-agent loop (bash/read_file/list_dir/grep) to react to the event.        |

### `command` protocol

- stdin: JSON envelope with event data
- exit code `0`: success, stdout optionally parsed as `HookJSONOutput` JSON
- exit code `2`: **block** — stderr becomes the block reason, shown to the agent
- any other exit code, or timeout: logged as a warning; stdout control fields are ignored
- `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` expand to the directory the
  hook was declared in / its data dir — usable in `command`
- `options` (fork-only field, no CC equivalent): exported as
  `CLAUDE_PLUGIN_OPTION_<KEY>` env vars in the subprocess

### Handler options and agent tools

- `timeout`: positive seconds; cancellation reaches the running process, model request or MCP tool.
- `shell`: command hooks can explicitly select `bash` or `powershell`; that interpreter must be installed. Omit it for `/bin/sh` on POSIX or `cmd.exe` on Windows.
- `allowedEnvVars`: when supplied, HTTP hooks expand `$NAME` and `${NAME}` in headers only for names in this list. Unlisted or unset variables expand to an empty string. When omitted, headers remain literal.
- `statusMessage`: recorded in the hook execution log before dispatch; it does not create a UI progress indicator.
- Command-level `once`: runs once per session for the current loaded configuration entry, including concurrent/async triggers. Reloading the file creates fresh entries. Session registration-level `once` atomically claims the whole matching group; unmatched conditions leave it available.
- Dynamic session registration supports the same command fields, including `options`.

Agent hooks provide `read_file`, `list_dir`, `grep`, and a restricted `bash` tool.
The latter directly executes installed POSIX system utilities with validated arguments;
it does not invoke a shell. It supports common read-only options for file inspection,
`find` predicates and `git status/log/diff/show`. `sed` is limited to
`-n '<line>[,<line>]p' <files>`. Interpreters such as `awk`, shell composition,
output-file options, external Git diff drivers and commands found through a
project-controlled PATH are unavailable. Use the three file tools on Windows.

### Common output fields (`HookJSONOutput`, applies across types)

```json
{
  "decision": "approve" | "block",
  "reason": "shown when blocking",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "additionalContext": "text injected into the session"
  }
}
```

`continue: false` stops prompt admission and wins over a Stop hook's request to
continue. Permission hooks can reject using `permissionDecision: "deny"`, a block
decision, or exit code 2. Post-tool block reasons and contexts are appended to
model-facing tool feedback after execution; they cannot undo a completed write.
`FileChanged` carries an absolute path and `add`, `change` or `delete`; patch
renames report both the removed path and the added destination.

Some fields are retained only for schema compatibility. `initialUserMessage`,
`watchPaths`, `updatedMCPToolOutput`, `displayMessage`, `compactSummary` and
`customSummary` emit unsupported-output warnings and do not alter runtime state.
Use `additionalContext` for model feedback. `suppressOutput` remains a no-op:
hook stdout is not displayed directly in the UI. Prompt/agent hooks using OpenAI
OAuth are currently skipped with a warning; use a supported API-key provider.
Invalid output shapes are logged and ignored before aggregation.

## Applying changes

Global, project and worktree `hooks.json` files are polled every ~2 seconds,
with a 500 ms debounce. Changes take effect within a few seconds. Invalid
matcher/command entries are logged and skipped while valid siblings remain active.

## Migrating from Claude Code

`/import-claude-hooks` reads `~/.claude/settings.json` / `./.claude/settings.json`
/ `.claude/settings.local.json`, walks the user through importing each hook,
and writes approved ones into the right `hooks.json`. Point users here instead
of hand-copying Claude Code hook config.
