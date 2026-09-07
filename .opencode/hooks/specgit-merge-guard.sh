#!/bin/sh
# SpecGit guard (managed by specgit init): start gate + merge guard. Exit 2 = block with reason.
GUARD_DIR=$(cd "$(dirname "$0")" && pwd)
export GUARD_DIR
# Hook payloads arrive as the first argument or on stdin; accept both.
if [ -n "$1" ]; then
  payload=$1
else
  payload=$(cat)
fi
tool=$(printf '%s' "$payload" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_name)||'')}catch{process.stdout.write('')}})")
case "$tool" in
  edit|write|Edit|Write)
    # Start gate (#335): mutating files requires the delivery binding on
    # THIS branch. The record's context.branch is written by specgit and
    # matched as a fixed WHOLE line — no YAML parsing, no prefix collision
    # (branch "feat/1-a" must never satisfy a record for "feat/1-a2").
    branch=$(git branch --show-current 2>/dev/null)
    if [ -z "$branch" ] || [ ! -f .specgit.yaml ] || ! grep -qFx "  branch: $branch" .specgit.yaml; then
      echo "specgit: start gate - this branch has no delivery binding. Start the delivery first according to the managed guidance: prepare any required body files, then run specgit issue \"<type>: <title>\" with them before editing files." >&2
      exit 2
    fi
    exit 0
    ;;
esac
command=$(printf '%s' "$payload" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&j.tool_input.command)||'')}catch{process.stdout.write('')}})")

# Classify statically visible forge-merge commands without executing or
# expanding shell input. The lexer understands quoting, command separators,
# environment assignments, env/command/exec wrappers, and forge-global repo
# selectors. It deliberately inspects only each simple command's executable
# and leading global options, so quoted prose such as echo "gh pr merge" does
# not trigger the gate.
merge_command=$(printf '%s' "$command" | node -e '
  const fs = require("fs");
  const source = fs.readFileSync(0, "utf8");
  const SQ = String.fromCharCode(39);
  const DQ = String.fromCharCode(34);
  const BS = String.fromCharCode(92);

  function tokenize(text) {
    const tokens = [];
    let word = "";
    let active = false;
    let quote = 0;
    const flush = () => {
      if (!active) return;
      tokens.push({ kind: "word", value: word });
      word = "";
      active = false;
    };
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quote === 39) {
        if (char === SQ) quote = 0;
        else word += char;
        continue;
      }
      if (quote === 34) {
        if (char === DQ) {
          quote = 0;
        } else if (char === BS) {
          if (index + 1 >= text.length) return null;
          word += text[++index];
        } else {
          word += char;
        }
        continue;
      }
      if (char === SQ || char === DQ) {
        quote = char === SQ ? 39 : 34;
        active = true;
      } else if (char === BS) {
        if (index + 1 >= text.length) return null;
        const next = text[++index];
        if (next !== "\n") {
          word += next;
          active = true;
        }
      } else if (char === " " || char === "\t" || char === "\r") {
        flush();
      } else if (char === "\n" || char === ";" || char === "|" ||
                 char === "&" || char === "(" || char === ")") {
        flush();
        if ((char === "|" || char === "&") && text[index + 1] === char) index += 1;
        tokens.push({ kind: "boundary" });
      } else if (char === "#" && !active) {
        while (index + 1 < text.length && text[index + 1] !== "\n") index += 1;
      } else {
        word += char;
        active = true;
      }
    }
    if (quote !== 0) return null;
    flush();
    return tokens;
  }

  const executable = (word) => {
    const base = word.replace(/\\/g, "/").split("/").pop() || "";
    return base.toLowerCase().replace(/\.exe$/, "");
  };
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

  function unwrap(words) {
    let index = 0;
    while (assignment.test(words[index] || "")) index += 1;
    if (executable(words[index] || "") === "env") {
      index += 1;
      while (assignment.test(words[index] || "")) index += 1;
    }
    while (["command", "exec"].includes(executable(words[index] || ""))) {
      index += 1;
    }
    return words.slice(index);
  }

  function isForgeMerge(segment) {
    const words = unwrap(segment);
    const forge = executable(words[0] || "");
    if (forge !== "gh" && forge !== "glab") return false;
    let index = 1;
    while (index < words.length) {
      const option = words[index];
      if (["-R", "--repo", "--hostname"].includes(option)) {
        if (index + 1 >= words.length) return false;
        index += 2;
      } else if (option === "--" || option.startsWith("--repo=") ||
                 option.startsWith("--hostname=") ||
                 (option.startsWith("-R") && option.length > 2)) {
        index += 1;
        if (option === "--") break;
      } else {
        break;
      }
    }
    return forge === "gh"
      ? words[index] === "pr" && words[index + 1] === "merge"
      : words[index] === "mr" && words[index + 1] === "merge";
  }

  const tokens = tokenize(source);
  if (tokens === null) {
    process.stdout.write("indeterminate");
  } else {
    let segment = [];
    for (const token of [...tokens, { kind: "boundary" }]) {
      if (token.kind === "word") {
        segment.push(token.value);
      } else {
        if (isForgeMerge(segment)) {
          process.stdout.write("merge");
          process.exit(0);
        }
        segment = [];
      }
    }
  }
')
classifier_status=$?
if [ "$classifier_status" -ne 0 ]; then
  merge_command=indeterminate
fi

case "$merge_command" in
  indeterminate)
    echo "specgit: command blocked - the merge guard could not safely classify the shell input. Retry with a direct gh pr merge or glab mr merge command." >&2
    exit 2
    ;;
  merge)
    exec node -e '
      const { spawn } = require("child_process");
      const fs = require("fs");
      const path = require("path");
      const timeoutMs = ["SPECGIT_GH_TIMEOUT_MS", "SPECGIT_GLAB_TIMEOUT_MS"]
        .map((name) => parseInt(process.env[name] || "", 10))
        .map((value) => Number.isFinite(value) && value > 0 ? value : 15000);
      const providerS = Math.max(1, Math.ceil(Math.max(...timeoutMs) / 1000));
      let budgetS = Math.max(60, providerS * 8);
      const overrideRaw = parseInt(process.env.SPECGIT_GUARD_BUDGET_S || "", 10);
      if (Number.isFinite(overrideRaw) && overrideRaw > 0) {
        budgetS = Math.max(overrideRaw, providerS);
      }
      // The hook runner kills long hooks; surface the mismatch instead of
      // being cut off mid-verdict.
      try {
        const hooks = JSON.parse(
          fs.readFileSync(path.join(process.env.GUARD_DIR || ".", "..", "hooks.json"), "utf8")
        );
        const runner = (hooks.PreToolUse || [])
          .flatMap((entry) => entry.hooks || [])
          .map((hook) => hook.timeout)
          .find((timeout) => typeof timeout === "number");
        if (runner !== undefined && runner - 10 < budgetS) {
          console.error(
            "specgit: guard budget " + budgetS + "s exceeds the hook runner timeout " +
              runner + "s in .opencode/hooks.json - raise the runner timeout or lower SPECGIT_GUARD_BUDGET_S."
          );
        }
      } catch {}
      const cp = require("child_process");
      const isWin = process.platform === "win32";
      // Windows: cmd.exe cannot exec an extensionless sh shim, so prefer
      // git-bash sh when present; only then fall back to shell mode.
      let child;
      if (isWin) {
        const probe = cp.spawnSync("sh", ["-c", "exit 0"]);
        if (probe.status === 0) {
          child = spawn("sh", ["-c", "specgit finish --json"], {
            stdio: ["ignore", "pipe", "pipe"],
          });
        }
      }
      if (!child) {
        child = spawn("specgit", ["finish", "--json"], {
          shell: isWin,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
      let out = "";
      let err = "";
      let expired = false;
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      const timer = setTimeout(() => {
        expired = true;
        // Bound the wait strictly: descendants may inherit the pipes, so
        // destroy them and exit now — never lag behind orphaned children.
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill("SIGKILL");
        console.error(
          "specgit: merge blocked - guard budget " + budgetS + "s exhausted before a verdict. This says nothing about the delivery; run specgit finish directly for the full verdict."
        );
        process.exit(2);
      }, budgetS * 1000);
      child.on("error", (error) => {
        clearTimeout(timer);
        console.error(
          "specgit: merge blocked - the verdict could not run (" + error.message + "). Install specgit on PATH, then retry the merge."
        );
        process.exit(2);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (expired) {
          process.exit(2);
        }
        if (code === 0) {
          process.exit(0);
        }
        let envelope = null;
        try {
          envelope = JSON.parse(out);
        } catch {}
        const verdict = envelope && envelope.verdict;
        const gates = (envelope && (envelope.gates || (verdict && verdict.gates))) || [];
        const failures = [];
        for (const gate of gates) {
          for (const failure of (gate && gate.failures) || []) failures.push(failure);
        }
        const label = (failure, suffix) => {
          const detail = failure.detail || {};
          const name = detail.name || failure.code;
          const state = suffix || detail.status || detail.conclusion || "";
          return name + (state ? " [" + state + "]" : "");
        };
        const pending = failures.filter((f) => f.code === "checks_pending");
        const failed = failures.filter((f) => f.code === "checks_failed");
        const other = failures.filter(
          (f) => f.code !== "checks_pending" && f.code !== "checks_failed"
        );
        const lines = [];
        if (code === 1) {
          lines.push(
            "specgit: merge blocked - verdict rejected (exit 1). Fix what the failures name; never weaken spec_git/policy.yaml to pass."
          );
        } else {
          lines.push(
            "specgit: merge blocked - no verdict possible (evidence incomplete, exit " + code + "). This is not a rejection: follow errors[].fix in the specgit finish --json result first. Run specgit doctor --json only for git, repository, origin, configured provider CLI/auth, or policy probes, then retry."
          );
        }
        if (pending.length > 0) {
          lines.push(
            "  pending (transient - wait, then re-run): " + pending.map((f) => label(f)).join(", ")
          );
        }
        if (failed.length > 0) {
          lines.push(
            "  failed (repair required): " +
              failed
                .map((f) =>
                  label(
                    f,
                    f.detail && f.detail.conclusion === "action_required"
                      ? "action_required - run awaits maintainer approval"
                      : undefined
                  )
                )
                .join(", ")
          );
        }
        if (other.length > 0) {
          lines.push("  other failures: " + other.map((f) => label(f)).join(", "));
        }
        lines.push("Full verdict: specgit finish");
        console.error(lines.join("\n"));
        process.exit(2);
      });
    '
    ;;
esac
unset classifier_status merge_command

specgit_default_ref() {
  specgit_ref=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null) || return 1
  case "$specgit_ref" in
    refs/remotes/origin/HEAD) return 1 ;;
    refs/remotes/origin/?*) ;;
    *) return 1 ;;
  esac
  git rev-parse --verify "$specgit_ref^{commit}" >/dev/null 2>&1 || return 1
  printf '%s' "$specgit_ref"
}

case "$command" in
  git\ push\ origin\ *)
    default_ref=$(specgit_default_ref) || {
      echo "specgit: cannot prove origin/HEAD. Run git fetch origin and git remote set-head origin -a before pushing." >&2
      exit 2
    }
    default_branch=${default_ref#refs/remotes/origin/}
    case "$command" in
      git\ push\ origin\ "$default_branch"|git\ push\ origin\ "$default_branch"\ *|git\ push\ origin\ +"$default_branch"|git\ push\ origin\ +"$default_branch"\ *|git\ push\ origin\ HEAD:"$default_branch"|git\ push\ origin\ HEAD:"$default_branch"\ *)
        echo "specgit: direct push to $default_branch is not the delivery path. Deliveries go: specgit issue -> PR/MR -> CI -> specgit finish (exit 0) -> merge." >&2
        exit 2
        ;;
    esac
    ;;
esac
exit 0
