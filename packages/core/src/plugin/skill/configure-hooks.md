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
- names using letters, digits or underscores — exact match (case-insensitive), optionally pipe-separated
- other strings — treated as a regex tested against the target

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
could never fire. Entries naming it in hooks.json are silently skipped; delete
them.

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

### `inputFormat` — Claude Code envelope naming (command hooks only)

Command hooks accept an optional `inputFormat` field:

- `"opencode"` (default): the stdin envelope carries native OpenCode naming —
  lowercase tool ids (`bash`, `read`, `grep`, …) and native input keys
  (`filePath`, `oldString`, `include`, …).
- `"claude-code"`: the envelope is translated toward Claude Code naming so an
  unmodified CC hook script keeps working:
  - `tool_name` is canonicalized case-insensitively for known builtins only:
    `bash`→`Bash`, `read`→`Read`, `write`→`Write`, `edit`→`Edit`,
    `grep`→`Grep`, `glob`→`Glob`. Names outside this six-name set, including
    MCP and custom names, pass through unchanged. A custom tool shadowing one
    of these names receives the same naming translation.
  - `tool_input` keys are mapped: `filePath`→`file_path` (read/write/edit);
    `oldString`/`newString`/`replaceAll`→`old_string`/`new_string`/`replace_all`
    (edit); `include`→`glob` (grep). Original keys and unrelated fields are
    preserved; where a Claude key is already present with a non-null value,
    it wins and the native key is not written over it.
  - On `PreToolUse`, for the same six known names, a
    `hookSpecificOutput.updatedInput` returned by the hook is translated back
    to native keys before the tool runs; explicit Claude keys win over
    translated aliases. The rewrite direction also applies only to known
    names: for tools outside the set, a returned `updatedInput` is passed
    through unchanged, so such a hook must emit native keys (`filePath`,
    `oldString`, `include`, …) to rewrite a call.

This is naming compatibility only, not full tool semantic equivalence: hook
output handling and tool responses are unchanged, and behavioral differences
between Claude Code and OpenCode tools still surface. Verify a ported hook by
actually running it and checking what it receives on stdin, what it returns,
and any context it injects into the session — the hook listing in the Active
Hooks block, or exiting 0, does not prove its augmentation logic fired.

Example — reusing a Claude Code edit-guard hook unchanged:

```json
{
  "PreToolUse": [
    {
      "matcher": "Edit",
      "hooks": [{ "type": "command", "command": "./scripts/guard.py", "inputFormat": "claude-code" }]
    }
  ]
}
```

`guard.py` sees `tool_name: "Edit"` and `tool_input.file_path` /
`old_string` / `new_string`; its permission-decision output is handled exactly
as in Claude Code.

### Handler options and agent tools

- `timeout`: positive seconds; cancellation reaches the running process, model request or MCP tool.
- `shell`: command hooks can explicitly select `bash` or `powershell`; that interpreter must be installed. Omit it for `/bin/sh` on POSIX or `cmd.exe` on Windows.
- `inputFormat`: command hooks only — `"opencode"` (default) or `"claude-code"` for Claude Code envelope naming; contract in the `inputFormat` section above.
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
decision, or exit code 2.

A PreToolUse `permissionDecision: "ask"` is a forced ask: the user always
confirms it, even after an earlier "always" approval, and the dialog shows the
input the tool will run with, including any `updatedInput`, plus the hook's
`permissionDecisionReason`. A PermissionRequest hook can deny a forced ask, but
its `allow` is ignored (logged). Once confirmed, the tool's own ask-level
permission checks for that call do not prompt again; deny rules still apply.
`opencode run --dangerously-skip-permissions` is an automatic mode and approves
forced asks once; without it, `run` rejects them.

Post-tool block reasons and contexts are appended to
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
