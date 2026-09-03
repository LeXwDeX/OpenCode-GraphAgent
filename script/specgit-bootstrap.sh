#!/bin/sh
# specgit-bootstrap — repository-local fail-safe wrapper around `specgit issue` (#521).
#
# Why: `specgit issue` (1.10.1) runs an unconditional harness-currency gate that
# exits 2 (`harness_stale`) unless the managed harness was refreshed by
# `specgit init --force`. But `init --force` overwrites this repository's six
# hand-applied specializations (see AGENTS.md, "SpecGit harness local
# specializations"). This wrapper makes the refresh safe:
#
#   1. refuses to run when any init write-surface path has uncommitted changes
#      (tracked, staged, or untracked), or when the repo has no SpecGit binding;
#   2. snapshots every existing write-surface path to a temp directory OUTSIDE
#      the repository, recording each file's `git hash-object` content hash;
#   3. runs `specgit init --force --no-protect` (hardcoded, offline; init's
#      stdout prose is routed to stderr so a wrapped `--json` call's stdout
#      stays exactly one JSON document) then `specgit issue "$@"` with all
#      arguments preserved verbatim and stdin/stdout/stderr inherited;
#   4. restores the snapshots on every exit path (EXIT/INT/TERM/HUP) and
#      verifies each restored file byte-for-byte against the recorded hash;
#      any mismatch is reported loudly and exits 3.
#
# The `.specgit.yaml` delivery record gets conditional rollback (#530): a
# failed inner `specgit issue` (nonzero exit, signal, or init failure) has its
# pre-run bytes restored byte-for-byte; a successful inner call keeps the new
# binding. Record-restore failure keeps the snapshot for forensics and exits
# 3, overriding the inner exit code. Branches, commits, and remote side
# effects are never undone. Wrapper rejections print plain stderr lines
# prefixed `specgit-bootstrap:` — never a `--json` envelope; only the inner
# CLI receives the wrapped arguments.
#
# Usage: script/specgit-bootstrap.sh <specgit issue args...>
#
# Write surface below mirrors specgit 1.10.1 harness-placement; it is
# version-coupled to the pinned CLI in .github/workflows/specgit-accept.yml.

set -u

SURFACE='
.github/workflows/specgit-accept.yml
AGENTS.md
CLAUDE.md
.opencode/hooks.json
.opencode/hooks/specgit-merge-guard.sh
.git/hooks/pre-push
.husky/_/pre-push
'

say() {
  printf 'specgit-bootstrap: %s\n' "$1" >&2
}

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || {
  say "not inside a git repository"
  exit 3
}
cd "$REPO" || exit 3

# Fail-closed: serve only bound delivery repositories; a fresh repo has no
# specializations to protect, so bare `specgit issue` is fine there.
if [ ! -f .specgit.yaml ] || [ ! -f spec_git/policy.yaml ]; then
  say "no SpecGit binding (.specgit.yaml / spec_git/policy.yaml missing) - run bare 'specgit issue' instead"
  exit 3
fi

# Fail-closed: ambiguous pre-existing changes on the write surface could be
# clobbered by init and could not be told apart from init's own writes.
# shellcheck disable=SC2086
dirty=$(git status --porcelain -- $SURFACE)
if [ -n "$dirty" ]; then
  say "refusing to run - init write-surface paths have uncommitted changes (inner CLI NOT executed):"
  printf '%s\n' "$dirty" | sed 's/^/  /' >&2
  say "commit or stash those changes first, then retry"
  exit 2
fi

SNAP=$(mktemp -d "${TMPDIR:-/tmp}/specgit-bootstrap.XXXXXX") || {
  say "cannot create snapshot directory under \${TMPDIR:-/tmp}"
  exit 3
}
mkdir "$SNAP/tree" "$SNAP/hashes" || {
  rm -rf "$SNAP"
  say "cannot prepare snapshot directory layout"
  exit 3
}

# shellcheck disable=SC2086
for rel in $SURFACE; do
  [ -f "$rel" ] || continue
  mkdir -p "$SNAP/tree/$(dirname "$rel")" "$SNAP/hashes/$(dirname "$rel")" || {
    rm -rf "$SNAP"
    say "cannot stage snapshot for $rel"
    exit 3
  }
  cp "$rel" "$SNAP/tree/$rel" || {
    rm -rf "$SNAP"
    say "snapshot copy failed for $rel"
    exit 3
  }
  git hash-object -- "$rel" > "$SNAP/hashes/$rel" || {
    rm -rf "$SNAP"
    say "content hash failed for $rel"
    exit 3
  }
done

# Conditional record rollback (#530): snapshot the pre-run `.specgit.yaml`
# bytes so a failed inner call can restore them; snapshot failure aborts
# before any side effect.
RECORD_SNAPPED=0
cp .specgit.yaml "$SNAP/tree/.specgit.yaml" || {
  rm -rf "$SNAP"
  say "snapshot copy failed for .specgit.yaml"
  exit 3
}
git hash-object -- .specgit.yaml > "$SNAP/hashes/.specgit.yaml" || {
  rm -rf "$SNAP"
  say "content hash failed for .specgit.yaml"
  exit 3
}
RECORD_SNAPPED=1

RESTORED=0
# Default "failed until the inner call proves success": signal and init
# failure paths hit restore_all before `issue_status` is ever assigned.
issue_status=1

# Idempotent restore + byte verification. On mismatch the snapshot directory
# is KEPT for forensics and the wrapper exits 3 (fail-closed, aligning with
# the CLI's exit contract for "cannot proceed").
restore_all() {
  [ "$RESTORED" -eq 1 ] && return 0
  RESTORED=1
  mismatched=0
  # shellcheck disable=SC2086
  for rel in $SURFACE; do
    [ -f "$SNAP/tree/$rel" ] || continue
    cp "$SNAP/tree/$rel" "$rel"
    now=$(git hash-object -- "$rel" 2>/dev/null)
    want=$(cat "$SNAP/hashes/$rel" 2>/dev/null)
    if [ "$now" != "$want" ]; then
      printf 'specgit-bootstrap: RESTORE MISMATCH for %s (got %s, expected %s)\n' \
        "$rel" "${now:-<none>}" "${want:-<none>}" >&2
      mismatched=1
    fi
  done
  # Roll back the delivery record only when the inner bootstrap failed;
  # success keeps the new binding verbatim (#530).
  if [ "$RECORD_SNAPPED" -eq 1 ] && [ "$issue_status" -ne 0 ]; then
    if [ -f "$SNAP/tree/.specgit.yaml" ]; then
      cp "$SNAP/tree/.specgit.yaml" .specgit.yaml
      now=$(git hash-object -- .specgit.yaml 2>/dev/null)
      want=$(cat "$SNAP/hashes/.specgit.yaml" 2>/dev/null)
      if [ "$now" != "$want" ]; then
        printf 'specgit-bootstrap: RESTORE MISMATCH for %s (got %s, expected %s)\n' \
          ".specgit.yaml" "${now:-<none>}" "${want:-<none>}" >&2
        mismatched=1
      fi
    else
      printf 'specgit-bootstrap: RESTORE MISMATCH for %s (snapshot missing)\n' ".specgit.yaml" >&2
      mismatched=1
    fi
  fi
  if [ "$mismatched" -eq 1 ]; then
    say "restored bytes differ from pre-run snapshots - specialized harness bytes may be corrupted."
    say "snapshot kept for forensics at $SNAP; inspect 'git diff' before continuing."
    trap - EXIT
    exit 3
  fi
  rm -rf "$SNAP"
}

trap 'restore_all' EXIT
trap 'restore_all; exit 129' HUP
trap 'restore_all; exit 130' INT
trap 'restore_all; exit 143' TERM

# init's stdout prose must not pollute the wrapped --json parse surface.
specgit init --force --no-protect >&2
init_status=$?
if [ "$init_status" -ne 0 ]; then
  say "specgit init --force --no-protect failed (exit $init_status); restoring harness bytes"
  restore_all
  exit "$init_status"
fi

# All arguments pass through verbatim; exit status and diagnostics inherit.
specgit issue "$@"
issue_status=$?
restore_all
exit "$issue_status"
