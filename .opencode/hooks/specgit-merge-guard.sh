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
      echo "specgit: start gate - this branch has no delivery binding. Start the delivery first: specgit issue \"<type>: <title>\", then fill each issue body from the discussion, then edit files." >&2
      exit 2
    fi
    exit 0
    ;;
esac
command=$(printf '%s' "$payload" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&j.tool_input.command)||'')}catch{process.stdout.write('')}})")

case "$command" in
  gh\ pr\ merge*)
    exec node -e '
      const { spawn } = require("child_process");
      const fs = require("fs");
      const path = require("path");
      const ghMsRaw = parseInt(process.env.SPECGIT_GH_TIMEOUT_MS || "", 10);
      const ghMs = Number.isFinite(ghMsRaw) && ghMsRaw > 0 ? ghMsRaw : 15000;
      const ghS = Math.max(1, Math.floor(ghMs / 1000));
      let budgetS = Math.max(60, ghS * 8);
      const overrideRaw = parseInt(process.env.SPECGIT_GUARD_BUDGET_S || "", 10);
      if (Number.isFinite(overrideRaw) && overrideRaw > 0) {
        budgetS = Math.max(overrideRaw, ghS);
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
            "specgit: merge blocked - no verdict possible (evidence incomplete, exit " + code + "). This is not a rejection: fix evidence gathering (network, gh auth), then retry."
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
  git\ push\ origin\ main*|git\ push\ origin\ +main*|git\ push\ origin\ HEAD:main*)
    echo "specgit: direct push to main is not the delivery path. Deliveries go: specgit issue -> PR -> CI -> specgit finish (exit 0) -> merge." >&2
    exit 2
    ;;
esac
exit 0
