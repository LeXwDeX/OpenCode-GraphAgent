#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2329
# ok/bad always return 0, so `cond && ok .. || bad ..` cannot mis-fire (SC2015);
# cleanup() runs via the EXIT trap, which shellcheck does not count (SC2329).
# Behavior tests for script/specgit-bootstrap.sh (#521, #530 record rollback,
# #529 issue-title type preflight).
#
# Zero network, zero forge: `specgit` is a stub placed first on PATH; every
# fixture is a throwaway git repo under $TMPDIR. The real repository is never
# touched: wrapper invocations run with cwd set to the fixture, and all stub
# artifacts (log, captured output) live outside the fixture worktree.
#
# Not wired into CI (#521 scope): run manually from anywhere via
#   bash script/specgit-bootstrap.test.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WRAPPER="$ROOT/script/specgit-bootstrap.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/specgit-bootstrap-test.XXXXXX")
PASS=0
FAIL=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | cut -d' ' -f1; }
else
  digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

SURFACE_FILES=(
  .github/workflows/specgit-accept.yml
  AGENTS.md
  .opencode/hooks.json
  .opencode/hooks/specgit-merge-guard.sh
  .git/hooks/pre-push
)

ok() { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$1"; }

surface_digests() { # <fixture-dir>
  local fx="$1" f
  for f in "${SURFACE_FILES[@]}"; do
    printf '%s %s\n' "$(digest "$fx/$f")" "$f"
  done
}

assert_surface_restored() { # <fixture-dir> <baseline-file>
  diff <(surface_digests "$1") "$2" >/dev/null
}

assert_clean() { # <fixture-dir>
  [ -z "$(git -C "$1" status --porcelain)" ]
}

assert_rc() { # <expected> <actual> <label>
  [ "$1" = "$2" ]
}

new_fixture() { # <name> [no-binding]
  local fx="$WORK/$1"
  mkdir -p "$fx/.github/workflows" "$fx/.opencode/hooks" "$fx/spec_git" "$fx/.git/hooks"
  git -C "$fx" -c init.defaultBranch=main init -q
  git -C "$fx" config user.email test@example.invalid
  git -C "$fx" config user.name test
  printf 'version: 1\nkind: probe\n' > "$fx/spec_git/policy.yaml"
  printf 'version: 1\nbranch: feat/probe\nissues: []\n' > "$fx/.specgit.yaml"
  cat > "$fx/.github/workflows/specgit-accept.yml" <<'YAML'
# fixture accept workflow
spec-a: drop-dispatch
spec-b: global-install
YAML
  printf '# fixture agents\n' > "$fx/AGENTS.md"
  printf '{\n  "hooks": []\n}\n' > "$fx/.opencode/hooks.json"
  printf '#!/bin/sh\nexit 0\n' > "$fx/.opencode/hooks/specgit-merge-guard.sh"
  printf '#!/bin/sh\nexit 0\n' > "$fx/.git/hooks/pre-push"
  git -C "$fx" add -A
  git -C "$fx" commit -qm "fixture $1"
  if [ "${2:-}" = "no-binding" ]; then
    rm "$fx/.specgit.yaml"
  fi
}

make_stub() { # <case-name>
  local dir="$WORK/stubs/$1"
  mkdir -p "$dir"
  : > "$dir/log"
  : > "$dir/log.argv"
  cat > "$dir/specgit" <<'EOF'
#!/usr/bin/env bash
# stub specgit: records argv to $STUB_LOG, simulates harness refresh plus the
# scripted exit/mode contract. Never touches network or forge.
set -u
printf '%s\n' "$*" >> "${STUB_LOG:?STUB_LOG required}"
# NUL-separated argv sidecar: preserves argument boundaries, so tests can
# assert byte-exact passthrough (the "$*" log above cannot).
printf '%s\0' "$@" >> "${STUB_LOG:?STUB_LOG required}.argv"
cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  init)
    printf 'specgit init: refreshing harness files\n'
    printf '\n# canonical harness refresh (stub init)\n' >> .github/workflows/specgit-accept.yml
    exit "${STUB_INIT_EXIT:-0}"
    ;;
  issue)
    grep -q 'canonical harness refresh' .github/workflows/specgit-accept.yml || {
      printf 'stub: refreshed harness bytes were not visible to the inner CLI\n' >&2
      exit 99
    }
    case "${STUB_ISSUE_MODE:-exit}" in
      exit)
        [ "${1:-}" = "--json" ] && printf '{"stub":"issue"}\n'
        exit "${STUB_ISSUE_EXIT:-0}"
        ;;
      reject130)
        printf 'Interrupted.' >&2
        exit 130
        ;;
      sigint)
        trap 'printf "Interrupted." >&2; exit 130' INT
        # Deliver a real SIGINT to the wrapper (our foreground parent). A
        # background wrapper would inherit SIG_IGN at exec (signals ignored
        # upon entry cannot be trapped), so the stub is the delivery seam.
        kill -INT "${STUB_SIGNAL_TARGET:-$PPID}"
        sleep 1
        exit 0
        ;;
      tamper_snapshot)
        d=$(ls -dt "${TMPDIR:-/tmp}"/specgit-bootstrap.* 2>/dev/null | sed -n '1p')
        if [ -n "$d" ] && [ -f "$d/tree/.github/workflows/specgit-accept.yml" ]; then
          printf 'tampered-by-test\n' > "$d/tree/.github/workflows/specgit-accept.yml"
        fi
        exit "${STUB_ISSUE_EXIT:-0}"
        ;;
      fail_after_branch_write)
        printf 'version: 1\nbranch: feat/probe\nissues: [530]\n' > .specgit.yaml
        exit "${STUB_ISSUE_EXIT:-3}"
        ;;
      fail_after_push_delete)
        rm -f .specgit.yaml
        exit "${STUB_ISSUE_EXIT:-3}"
        ;;
      fail_after_pr_write)
        printf 'version: 1\nbranch: feat/probe\nissues: [530, 533]\n' > .specgit.yaml
        exit "${STUB_ISSUE_EXIT:-3}"
        ;;
      fail_after_push_commit)
        printf 'version: 1\nbranch: feat/probe\nissues: [530]\n' > .specgit.yaml
        git add .specgit.yaml
        git commit -qm "stub: record delivery binding"
        exit "${STUB_ISSUE_EXIT:-3}"
        ;;
      succeed_after_record_write)
        printf 'version: 1\nbranch: feat/probe\nissues: [530]\n' > .specgit.yaml
        exit 0
        ;;
      tamper_record_snapshot)
        d=$(ls -dt "${TMPDIR:-/tmp}"/specgit-bootstrap.* 2>/dev/null | sed -n '1p')
        if [ -n "$d" ] && [ -d "$d/tree" ]; then
          printf 'tampered-record\n' > "$d/tree/.specgit.yaml"
          printf '%s\n' "$d" >> "${STUB_LOG}.snapdir"
        fi
        exit "${STUB_ISSUE_EXIT:-0}"
        ;;
    esac
    ;;
  *)
    printf 'stub: unknown subcommand: %s\n' "$cmd" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$dir/specgit"
}

# run_wrapper <case> [args...]  — env knobs must already be exported.
run_wrapper() {
  local case="$1"
  shift
  local fx="$WORK/$case"
  ( cd "$fx" && env PATH="$WORK/stubs/$case:$PATH" STUB_LOG="$WORK/stubs/$case/log" "$WRAPPER" "$@" > "$WORK/$case.out" 2> "$WORK/$case.err" )
}

# want_argv <file> <issue-args...> — expected stub sidecar stream: the init
# record followed by the issue record, NUL-separated exactly as the stub
# writes them (byte-exact passthrough evidence, unlike the "$*" log).
want_argv() {
  local f="$1"
  shift
  {
    printf 'init\0--force\0--no-protect\0'
    printf 'issue\0'
    printf '%s\0' "$@"
  } > "$f"
}

# assert_argv <case> — stub sidecar must byte-equal the want_argv file.
assert_argv() {
  cmp -s "$WORK/$1.wantargv" "$WORK/stubs/$1/log.argv" \
    && ok "$1: argv byte-exact through wrapper" \
    || bad "$1: argv sidecar mismatch (wrapper rewrote or dropped bytes)"
}

# expect_reject <case> <diag-needle> <args...> — #529 preflight rejection:
# exit 2, specgit-bootstrap: diagnostics naming the violation, zero stub
# calls (no init, no inner CLI), empty stdout (no JSON envelope), fixture
# untouched.
expect_reject() {
  local case="$1" needle="$2"
  shift 2
  new_fixture "$case"
  make_stub "$case"
  run_wrapper "$case" "$@"
  local rc=$?
  assert_rc 2 "$rc" && ok "$case: preflight exits 2" || bad "$case: exit $rc, want 2"
  grep -q '^specgit-bootstrap:' "$WORK/$case.err" && ok "$case: diagnostics use specgit-bootstrap: prefix" || bad "$case: missing prefix"
  grep -qF -- "$needle" "$WORK/$case.err" && ok "$case: diagnostic names the violation" || bad "$case: diagnostic lacks '$needle': $(tr '\n' '|' < "$WORK/$case.err")"
  { [ ! -s "$WORK/stubs/$case/log" ] && [ ! -s "$WORK/stubs/$case/log.argv" ]; } \
    && ok "$case: zero stub calls (no init, no inner CLI)" \
    || bad "$case: stub was called: $(tr '\n' '|' < "$WORK/stubs/$case/log")"
  [ ! -s "$WORK/$case.out" ] && ok "$case: stdout empty (no JSON envelope)" || bad "$case: stdout not empty: $(tr '\n' '|' < "$WORK/$case.out")"
  assert_clean "$WORK/$case" && ok "$case: fixture untouched" || bad "$case: fixture dirty: $(git -C "$WORK/$case" status --porcelain | tr '\n' '|')"
}

report() {
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ]
}

[ -x "$WRAPPER" ] || {
  bad "wrapper executable exists at script/specgit-bootstrap.sh"
  report
  exit 1
}

# ==== #529: issue-title type preflight ======================================
# Rejection group: unsupported types must exit 2 with zero side effects,
# before specgit init or any inner CLI execution. No type is ever mapped.
expect_reject c18 "unsupported issue title type 'ci'" "ci: normalize coverage gates"
expect_reject c19 "unsupported issue title type 'perf'" "perf: speed up warm path"
expect_reject c20 "unsupported issue title type 'dogfood'" "dogfood: exercise wrapper"
expect_reject c21 "unsupported issue title type 'fix(tui)'" "fix(tui): simplify thinking toggle styling"
expect_reject c22 "unsupported issue title type 'Feat'" "Feat: capitalized probe"
expect_reject c23 "unsupported issue title syntax" "feat:no-space probe"
expect_reject c24 "unsupported issue title syntax" "feat:"
expect_reject c25 "unsupported issue title type 'upgrade the thing'" "upgrade the thing"
expect_reject c26 "unsupported issue title type '#529'" "#529"
expect_reject c27 "empty issue title" ""
expect_reject c28 "empty issue title" "   "
expect_reject c29 "unsupported issue title type 'ci'" -- "ci: after dd"
expect_reject c30 "unsupported issue title type 'ci'" "fix: ok" "ci: bad"
expect_reject c31 "unsupported issue title type 'ci'" --json "ci: x"
# vocabulary + corrective command, never a mapping
new_fixture c32h
make_stub c32h
run_wrapper c32h "ci: normalize coverage gates"
grep -q 'allowed types: chore docs feat fix hotfix refactor release test' "$WORK/c32h.err" \
  && ok "c32h: rejection names the full allowed vocabulary" \
  || bad "c32h: vocabulary line missing: $(tr '\n' '|' < "$WORK/c32h.err")"
grep -q 'no type mapping is performed' "$WORK/c32h.err" \
  && ok "c32h: rejection states no type mapping is performed" \
  || bad "c32h: corrective-command line missing"

# Pass group: every allowed form reaches the inner CLI byte-exact.
# ---- case 33 (#529): issue-number reuse passes preflight --------------------
new_fixture c33
make_stub c33
surface_digests "$WORK/c33" > "$WORK/c33.baseline"
want_argv "$WORK/c33.wantargv" 529
run_wrapper c33 529
rc=$?
assert_rc 0 "$rc" && ok "c33: number reuse 529 passes preflight" || bad "c33: exit $rc, want 0"
assert_argv c33
assert_surface_restored "$WORK/c33" "$WORK/c33.baseline" && ok "c33: surface bytes restored" || bad "c33: surface bytes differ"
assert_clean "$WORK/c33" && ok "c33: fixture clean" || bad "c33: fixture dirty"

# ---- case 34 (#529): number + valid title mixed targets ---------------------
new_fixture c34
make_stub c34
surface_digests "$WORK/c34" > "$WORK/c34.baseline"
want_argv "$WORK/c34.wantargv" 529 "fix: probe title"
run_wrapper c34 529 "fix: probe title"
rc=$?
assert_rc 0 "$rc" && ok "c34: mixed number + title passes preflight" || bad "c34: exit $rc, want 0"
assert_argv c34
assert_surface_restored "$WORK/c34" "$WORK/c34.baseline" && ok "c34: surface bytes restored" || bad "c34: surface bytes differ"

# ---- case 35 (#529): all eight allowed types, spelling retained byte-exact --
new_fixture c35
make_stub c35
for t in feat fix chore docs refactor test release hotfix; do
  : > "$WORK/stubs/c35/log"; : > "$WORK/stubs/c35/log.argv"
  want_argv "$WORK/c35.wantargv" "$t: probe title"
  run_wrapper c35 "$t: probe title"
  rc=$?
  assert_rc 0 "$rc" && ok "c35: '$t:' passes preflight" || bad "c35: '$t:' exit $rc, want 0"
  assert_argv c35
done
assert_clean "$WORK/c35" && ok "c35: fixture clean after 8 runs" || bad "c35: fixture dirty"

# ---- case 36 (#529): multi-line title (dotAll anchoring) --------------------
new_fixture c36
make_stub c36
surface_digests "$WORK/c36" > "$WORK/c36.baseline"
want_argv "$WORK/c36.wantargv" $'feat: multi\nline title'
run_wrapper c36 $'feat: multi\nline title'
rc=$?
assert_rc 0 "$rc" && ok "c36: multi-line title passes preflight" || bad "c36: exit $rc, want 0"
assert_argv c36

# ---- case 37 (#529): padded title passes raw (no silent rewrite/trim) -------
new_fixture c37
make_stub c37
surface_digests "$WORK/c37" > "$WORK/c37.baseline"
want_argv "$WORK/c37.wantargv" "   feat: padded title   "
run_wrapper c37 "   feat: padded title   "
rc=$?
assert_rc 0 "$rc" && ok "c37: padded title passes preflight" || bad "c37: exit $rc, want 0"
assert_argv c37

# ---- case 38 (#529): interleaved options; --tags/--delivery consume 1 value -
new_fixture c38
make_stub c38
surface_digests "$WORK/c38" > "$WORK/c38.baseline"
want_argv "$WORK/c38.wantargv" --json --tags feat,fix "fix: x" --delivery=add-login
run_wrapper c38 --json --tags feat,fix "fix: x" --delivery=add-login
rc=$?
assert_rc 0 "$rc" && ok "c38: interleaved options pass preflight" || bad "c38: exit $rc, want 0 (option values must not be read as titles)"
assert_argv c38

# ---- case 39 (#529): inline --tags= forms skip validation -------------------
new_fixture c39
make_stub c39
surface_digests "$WORK/c39" > "$WORK/c39.baseline"
want_argv "$WORK/c39.wantargv" --tags=feat,fix --delivery=add-login "docs: x"
run_wrapper c39 --tags=feat,fix --delivery=add-login "docs: x"
rc=$?
assert_rc 0 "$rc" && ok "c39: inline --tags= forms pass preflight" || bad "c39: exit $rc, want 0"
assert_argv c39

# ---- case 40 (#529): operands after -- are still validated but pass ---------
new_fixture c40
make_stub c40
surface_digests "$WORK/c40" > "$WORK/c40.baseline"
want_argv "$WORK/c40.wantargv" -- "chore: x"
run_wrapper c40 -- "chore: x"
rc=$?
assert_rc 0 "$rc" && ok "c40: valid title after -- passes" || bad "c40: exit $rc, want 0"
assert_argv c40

# ---- case 41 (#529): unknown flags are left to the inner CLI ----------------
new_fixture c41
make_stub c41
surface_digests "$WORK/c41" > "$WORK/c41.baseline"
want_argv "$WORK/c41.wantargv" --bogus "fix: probe"
run_wrapper c41 --bogus "fix: probe"
rc=$?
assert_rc 0 "$rc" && ok "c41: unknown flag does not trip preflight" || bad "c41: exit $rc, want 0"
assert_argv c41

# ---- case 42 (#529): -h short-circuits validation, argv intact --------------
new_fixture c42
make_stub c42
surface_digests "$WORK/c42" > "$WORK/c42.baseline"
want_argv "$WORK/c42.wantargv" -h
run_wrapper c42 -h
rc=$?
assert_rc 0 "$rc" && ok "c42: -h passes preflight (help answered by CLI)" || bad "c42: exit $rc, want 0"
assert_argv c42
[ -s "$WORK/stubs/c42/log" ] && ok "c42: inner CLI executed for -h" || bad "c42: stub not called"

# ---- case 43 (#529): numeric operand with leading zeros ---------------------
new_fixture c43
make_stub c43
surface_digests "$WORK/c43" > "$WORK/c43.baseline"
want_argv "$WORK/c43.wantargv" 007
run_wrapper c43 007
rc=$?
assert_rc 0 "$rc" && ok "c43: 007 passes preflight (number reuse)" || bad "c43: exit $rc, want 0"
assert_argv c43
assert_clean "$WORK/c43" && ok "c43: fixture clean" || bad "c43: fixture dirty"

# ---- case 1: success — args passed through verbatim, bytes restored --------
new_fixture c1
make_stub c1
surface_digests "$WORK/c1" > "$WORK/c1.baseline"
run_wrapper c1 --json "feat: probe title"
rc=$?
assert_rc 0 "$rc" "case1: wrapper exits 0" && ok "case1: wrapper exits 0" || bad "case1: wrapper exits 0 (got $rc)"
printf 'init --force --no-protect\nissue --json feat: probe title\n' > "$WORK/c1.wantlog"
diff "$WORK/stubs/c1/log" "$WORK/c1.wantlog" >/dev/null && ok "case1: argv order + passthrough (init first, issue verbatim)" || bad "case1: stub log mismatch: $(cat "$WORK/stubs/c1/log" | tr '\n' '|')"
assert_surface_restored "$WORK/c1" "$WORK/c1.baseline" && ok "case1: surface bytes restored" || bad "case1: surface bytes differ"
assert_clean "$WORK/c1" && ok "case1: fixture git status clean" || bad "case1: fixture dirty: $(git -C "$WORK/c1" status --porcelain | tr '\n' '|')"
printf '{"stub":"issue"}\n' > "$WORK/c1.wantout"
diff "$WORK/c1.out" "$WORK/c1.wantout" >/dev/null && ok "case1: --json stdout is exactly one JSON document (no init prose)" || bad "case1: stdout not a single JSON doc: $(tr '\n' '|' < "$WORK/c1.out")"
grep -q 'refreshing harness files' "$WORK/c1.err" && ok "case1: init stdout prose routed to stderr" || bad "case1: init prose missing from stderr"

# ---- case 2: inner rejected (exit 1) — passthrough + restore ---------------
new_fixture c2
make_stub c2
surface_digests "$WORK/c2" > "$WORK/c2.baseline"
STUB_ISSUE_EXIT=1 run_wrapper c2 "fix: probe"
rc=$?
assert_rc 1 "$rc" && ok "case2: wrapper exits 1 (inner rejected)" || bad "case2: exit $rc, want 1"
assert_surface_restored "$WORK/c2" "$WORK/c2.baseline" && ok "case2: surface bytes restored" || bad "case2: surface bytes differ"
assert_clean "$WORK/c2" && ok "case2: fixture clean" || bad "case2: fixture dirty"

# ---- case 3: harness_stale (exit 2) — passthrough + restore ----------------
new_fixture c3
make_stub c3
surface_digests "$WORK/c3" > "$WORK/c3.baseline"
STUB_ISSUE_EXIT=2 run_wrapper c3 "fix: probe"
rc=$?
assert_rc 2 "$rc" && ok "case3: wrapper exits 2 (harness_stale passthrough)" || bad "case3: exit $rc, want 2"
assert_surface_restored "$WORK/c3" "$WORK/c3.baseline" && ok "case3: surface bytes restored" || bad "case3: surface bytes differ"
assert_clean "$WORK/c3" && ok "case3: fixture clean" || bad "case3: fixture dirty"

# ---- case 4a: inner catches SIGINT and exits 130 — passthrough + restore ---
new_fixture c4a
make_stub c4a
surface_digests "$WORK/c4a" > "$WORK/c4a.baseline"
STUB_ISSUE_MODE=reject130 run_wrapper c4a "fix: probe"
rc=$?
assert_rc 130 "$rc" && ok "case4a: wrapper exits 130 (inner SIGINT contract)" || bad "case4a: exit $rc, want 130"
grep -q 'Interrupted.' "$WORK/c4a.err" && ok "case4a: inner stderr inherited (Interrupted.)" || bad "case4a: inner stderr not inherited"
assert_surface_restored "$WORK/c4a" "$WORK/c4a.baseline" && ok "case4a: surface bytes restored" || bad "case4a: surface bytes differ"
assert_clean "$WORK/c4a" && ok "case4a: fixture clean" || bad "case4a: fixture dirty"

# ---- case 4b: real SIGINT to the wrapper while inner runs ------------------
new_fixture c4b
make_stub c4b
surface_digests "$WORK/c4b" > "$WORK/c4b.baseline"
STUB_ISSUE_MODE=sigint run_wrapper c4b "fix: probe"
rc=$?
assert_rc 130 "$rc" && ok "case4b: wrapper exits 130 on trapped SIGINT" || bad "case4b: exit $rc, want 130"
assert_surface_restored "$WORK/c4b" "$WORK/c4b.baseline" && ok "case4b: surface bytes restored after signal" || bad "case4b: surface bytes differ"
assert_clean "$WORK/c4b" && ok "case4b: fixture clean" || bad "case4b: fixture dirty"

# ---- case 5: init fails — restore immediately, no issue call ---------------
new_fixture c5
make_stub c5
surface_digests "$WORK/c5" > "$WORK/c5.baseline"
STUB_INIT_EXIT=3 run_wrapper c5 "fix: probe"
rc=$?
assert_rc 3 "$rc" && ok "case5: wrapper exits 3 (init failure passthrough)" || bad "case5: exit $rc, want 3"
printf 'init --force --no-protect\n' > "$WORK/c5.wantlog"
diff "$WORK/stubs/c5/log" "$WORK/c5.wantlog" >/dev/null && ok "case5: issue never executed after init failure" || bad "case5: unexpected stub calls: $(tr '\n' '|' < "$WORK/stubs/c5/log")"
assert_surface_restored "$WORK/c5" "$WORK/c5.baseline" && ok "case5: surface bytes restored" || bad "case5: surface bytes differ"
assert_clean "$WORK/c5" && ok "case5: fixture clean" || bad "case5: fixture dirty"

# ---- case 6: dirty write surface — fail-closed rejection, zero stub calls --
new_fixture c6
make_stub c6
printf 'dirty work\n' >> "$WORK/c6/AGENTS.md"
printf 'untracked\n' > "$WORK/c6/CLAUDE.md"
run_wrapper c6 "fix: probe"
rc=$?
assert_rc 2 "$rc" && ok "case6: wrapper exits 2 on dirty write surface" || bad "case6: exit $rc, want 2"
[ ! -s "$WORK/stubs/c6/log" ] && ok "case6: inner CLI never executed" || bad "case6: stub was called: $(tr '\n' '|' < "$WORK/stubs/c6/log")"
grep -q 'AGENTS.md' "$WORK/c6.err" && ok "case6: stderr lists AGENTS.md" || bad "case6: stderr missing AGENTS.md"
grep -q 'CLAUDE.md' "$WORK/c6.err" && ok "case6: stderr lists untracked CLAUDE.md" || bad "case6: stderr missing CLAUDE.md"
grep -q '^specgit-bootstrap:' "$WORK/c6.err" && ok "case6: diagnostics use specgit-bootstrap: prefix" || bad "case6: missing prefix"
grep -q '"verdict"' "$WORK/c6.err" && bad "case6: rejection emitted a JSON envelope" || ok "case6: rejection emits no JSON envelope"
# deliberate dirty artifacts: assert bytes NOT touched by wrapper
grep -q 'dirty work' "$WORK/c6/AGENTS.md" && ok "case6: dirty fixture left untouched" || bad "case6: dirty fixture mutated"

# ---- case 7: snapshot tampering detected — loud mismatch, exit 3 -----------
new_fixture c7
make_stub c7
surface_digests "$WORK/c7" > "$WORK/c7.baseline"
STUB_ISSUE_MODE=tamper_snapshot run_wrapper c7 "fix: probe"
rc=$?
assert_rc 3 "$rc" && ok "case7: wrapper exits 3 on restore mismatch" || bad "case7: exit $rc, want 3"
grep -q 'RESTORE MISMATCH' "$WORK/c7.err" && ok "case7: mismatch reported loudly on stderr" || bad "case7: no RESTORE MISMATCH diagnostic"
grep -q 'tampered-by-test' "$WORK/c7/.github/workflows/specgit-accept.yml" && ok "case7: corrupted snapshot surfaced (deliberate artifact)" || bad "case7: workflow bytes unexpected: $(digest "$WORK/c7/.github/workflows/specgit-accept.yml")"
# every non-tampered surface file must be back to its committed bytes: the
# only porcelain entry may be the workflow the stub corrupted
[ "$(git -C "$WORK/c7" status --porcelain | grep -cv 'specgit-accept.yml')" = "0" ] && ok "case7: non-tampered files restored correctly" || bad "case7: unexpected residual changes: $(git -C "$WORK/c7" status --porcelain | tr '\n' '|')"

# ---- case 8: unbound repository — refuse service, zero execution -----------
new_fixture c8 no-binding
make_stub c8
run_wrapper c8 "feat: probe"
rc=$?
assert_rc 3 "$rc" && ok "case8: wrapper exits 3 on unbound repository" || bad "case8: exit $rc, want 3"
[ ! -s "$WORK/stubs/c8/log" ] && ok "case8: inner CLI never executed" || bad "case8: stub was called"
grep -q 'spec_git/policy.yaml\|\.specgit\.yaml' "$WORK/c8.err" && ok "case8: stderr names the missing binding" || bad "case8: stderr lacks binding context"
grep -q '^specgit-bootstrap:' "$WORK/c8.err" && ok "case8: diagnostics use specgit-bootstrap: prefix" || bad "case8: missing prefix"

# ---- case 9: validation failure — record untouched, rc passthrough ---------
new_fixture c9
make_stub c9
cp "$WORK/c9/.specgit.yaml" "$WORK/c9.record-baseline"
surface_digests "$WORK/c9" > "$WORK/c9.baseline"
STUB_ISSUE_EXIT=2 run_wrapper c9 "fix: probe"
rc=$?
assert_rc 2 "$rc" && ok "case9: wrapper exits 2 (validation failure passthrough)" || bad "case9: exit $rc, want 2"
diff "$WORK/c9/.specgit.yaml" "$WORK/c9.record-baseline" >/dev/null && ok "case9: record bytes untouched" || bad "case9: record bytes changed"
assert_surface_restored "$WORK/c9" "$WORK/c9.baseline" && ok "case9: surface bytes restored" || bad "case9: surface bytes differ"
assert_clean "$WORK/c9" && ok "case9: fixture clean" || bad "case9: fixture dirty: $(git -C "$WORK/c9" status --porcelain | tr '\n' '|')"

# ---- case 10: branch-creation failure — rewritten record rolled back --------
new_fixture c10
make_stub c10
cp "$WORK/c10/.specgit.yaml" "$WORK/c10.record-baseline"
surface_digests "$WORK/c10" > "$WORK/c10.baseline"
STUB_ISSUE_MODE=fail_after_branch_write STUB_ISSUE_EXIT=3 run_wrapper c10 "fix: probe"
rc=$?
assert_rc 3 "$rc" && ok "case10: wrapper exits 3 (branch failure passthrough)" || bad "case10: exit $rc, want 3"
diff "$WORK/c10/.specgit.yaml" "$WORK/c10.record-baseline" >/dev/null && ok "case10: rewritten record rolled back to pre-run bytes" || bad "case10: record not rolled back: $(tr '\n' '|' < "$WORK/c10/.specgit.yaml")"
assert_surface_restored "$WORK/c10" "$WORK/c10.baseline" && ok "case10: surface bytes restored" || bad "case10: surface bytes differ"
assert_clean "$WORK/c10" && ok "case10: fixture clean" || bad "case10: fixture dirty: $(git -C "$WORK/c10" status --porcelain | tr '\n' '|')"

# ---- case 11: push failure deleting the record — file recreated (#519) ------
new_fixture c11
make_stub c11
cp "$WORK/c11/.specgit.yaml" "$WORK/c11.record-baseline"
surface_digests "$WORK/c11" > "$WORK/c11.baseline"
STUB_ISSUE_MODE=fail_after_push_delete STUB_ISSUE_EXIT=3 run_wrapper c11 "fix: probe"
rc=$?
assert_rc 3 "$rc" && ok "case11: wrapper exits 3 (push failure passthrough)" || bad "case11: exit $rc, want 3"
[ -f "$WORK/c11/.specgit.yaml" ] && ok "case11: deleted record recreated" || bad "case11: record still missing"
diff "$WORK/c11/.specgit.yaml" "$WORK/c11.record-baseline" >/dev/null 2>&1 && ok "case11: record bytes byte-identical after deletion rollback" || bad "case11: record bytes: $(tr '\n' '|' < "$WORK/c11/.specgit.yaml" 2>/dev/null)"
assert_surface_restored "$WORK/c11" "$WORK/c11.baseline" && ok "case11: surface bytes restored" || bad "case11: surface bytes differ"
assert_clean "$WORK/c11" && ok "case11: fixture clean" || bad "case11: fixture dirty: $(git -C "$WORK/c11" status --porcelain | tr '\n' '|')"

# ---- case 12: PR-creation failure — rewritten record rolled back ------------
new_fixture c12
make_stub c12
cp "$WORK/c12/.specgit.yaml" "$WORK/c12.record-baseline"
surface_digests "$WORK/c12" > "$WORK/c12.baseline"
STUB_ISSUE_MODE=fail_after_pr_write STUB_ISSUE_EXIT=3 run_wrapper c12 "fix: probe"
rc=$?
assert_rc 3 "$rc" && ok "case12: wrapper exits 3 (PR failure passthrough)" || bad "case12: exit $rc, want 3"
diff "$WORK/c12/.specgit.yaml" "$WORK/c12.record-baseline" >/dev/null && ok "case12: rewritten record rolled back to pre-run bytes" || bad "case12: record not rolled back: $(tr '\n' '|' < "$WORK/c12/.specgit.yaml")"
assert_surface_restored "$WORK/c12" "$WORK/c12.baseline" && ok "case12: surface bytes restored" || bad "case12: surface bytes differ"
assert_clean "$WORK/c12" && ok "case12: fixture clean" || bad "case12: fixture dirty: $(git -C "$WORK/c12" status --porcelain | tr '\n' '|')"

# ---- case 13: success keeps the new binding ---------------------------------
new_fixture c13
make_stub c13
surface_digests "$WORK/c13" > "$WORK/c13.baseline"
STUB_ISSUE_MODE=succeed_after_record_write run_wrapper c13 "feat: probe"
rc=$?
assert_rc 0 "$rc" && ok "case13: wrapper exits 0" || bad "case13: exit $rc, want 0"
grep -q 'issues: \[530\]' "$WORK/c13/.specgit.yaml" && ok "case13: successful bootstrap keeps new binding" || bad "case13: new binding lost: $(tr '\n' '|' < "$WORK/c13/.specgit.yaml")"
assert_surface_restored "$WORK/c13" "$WORK/c13.baseline" && ok "case13: surface bytes restored" || bad "case13: surface bytes differ"
[ "$(git -C "$WORK/c13" status --porcelain | grep -cv 'specgit.yaml')" = "0" ] && ok "case13: only the record binding differs post-success" || bad "case13: unexpected residual changes: $(git -C "$WORK/c13" status --porcelain | tr '\n' '|')"

# ---- case 14: pre-run dirty record — dirty bytes restored, not committed ----
new_fixture c14
make_stub c14
printf 'version: 1\nbranch: feat/dirty-pre\nissues: [519]\n' > "$WORK/c14/.specgit.yaml"
cp "$WORK/c14/.specgit.yaml" "$WORK/c14.record-baseline"
surface_digests "$WORK/c14" > "$WORK/c14.baseline"
STUB_ISSUE_MODE=fail_after_branch_write STUB_ISSUE_EXIT=3 run_wrapper c14 "fix: probe"
rc=$?
assert_rc 3 "$rc" && ok "case14: wrapper exits 3" || bad "case14: exit $rc, want 3"
diff "$WORK/c14/.specgit.yaml" "$WORK/c14.record-baseline" >/dev/null && ok "case14: pre-run dirty bytes restored (not committed bytes)" || bad "case14: record bytes: $(tr '\n' '|' < "$WORK/c14/.specgit.yaml")"
assert_surface_restored "$WORK/c14" "$WORK/c14.baseline" && ok "case14: surface bytes restored" || bad "case14: surface bytes differ"

# ---- case 15: untracked record (git rm --cached) — restored byte-for-byte ---
new_fixture c15
make_stub c15
git -C "$WORK/c15" rm -q --cached .specgit.yaml
cp "$WORK/c15/.specgit.yaml" "$WORK/c15.record-baseline"
STUB_ISSUE_MODE=fail_after_pr_write STUB_ISSUE_EXIT=3 run_wrapper c15 "fix: probe"
rc=$?
assert_rc 3 "$rc" && ok "case15: wrapper exits 3" || bad "case15: exit $rc, want 3"
[ -f "$WORK/c15/.specgit.yaml" ] && ok "case15: untracked record file exists after restore" || bad "case15: record missing"
diff "$WORK/c15/.specgit.yaml" "$WORK/c15.record-baseline" >/dev/null && ok "case15: untracked record bytes restored" || bad "case15: record bytes: $(tr '\n' '|' < "$WORK/c15/.specgit.yaml")"

# ---- case 16: record snapshot tampering — loud mismatch, exit 3, snap kept --
new_fixture c16
make_stub c16
STUB_ISSUE_MODE=tamper_record_snapshot STUB_ISSUE_EXIT=1 run_wrapper c16 "fix: probe"
rc=$?
assert_rc 3 "$rc" && ok "case16: wrapper exits 3 on record restore mismatch" || bad "case16: exit $rc, want 3"
grep -q 'RESTORE MISMATCH for .specgit.yaml' "$WORK/c16.err" && ok "case16: record mismatch reported loudly on stderr" || bad "case16: no record RESTORE MISMATCH diagnostic"
snapdir=$(sed -n '1p' "$WORK/stubs/c16/log.snapdir" 2>/dev/null)
[ -n "$snapdir" ] && [ -d "$snapdir" ] && ok "case16: forensic snapshot kept" || bad "case16: snapshot removed: ${snapdir:-<none>}"
grep -q 'tampered-record' "$WORK/c16/.specgit.yaml" && ok "case16: corrupted record surfaced (deliberate artifact)" || bad "case16: record bytes unexpected"

# ---- case 17: failed push that committed — commit kept, worktree restored ---
new_fixture c17
make_stub c17
cp "$WORK/c17/.specgit.yaml" "$WORK/c17.record-baseline"
heads0=$(git -C "$WORK/c17" rev-list --count HEAD)
STUB_ISSUE_MODE=fail_after_push_commit STUB_ISSUE_EXIT=3 run_wrapper c17 "fix: probe"
rc=$?
assert_rc 3 "$rc" && ok "case17: wrapper exits 3" || bad "case17: exit $rc, want 3"
heads1=$(git -C "$WORK/c17" rev-list --count HEAD)
assert_rc $((heads0 + 1)) "$heads1" && ok "case17: commit made during failed bootstrap is NOT undone" || bad "case17: HEAD count $heads1, want $((heads0 + 1))"
git -C "$WORK/c17" show HEAD:.specgit.yaml > "$WORK/c17.head-record" 2>/dev/null && \
  grep -q 'issues: \[530\]' "$WORK/c17.head-record" && ok "case17: committed record content intact in HEAD" || bad "case17: HEAD record missing stub content"
diff "$WORK/c17/.specgit.yaml" "$WORK/c17.record-baseline" >/dev/null && ok "case17: only the record's worktree diff restored" || bad "case17: worktree record not restored: $(tr '\n' '|' < "$WORK/c17/.specgit.yaml")"
[ "$(git -C "$WORK/c17" status --porcelain | grep -cv 'specgit.yaml')" = "0" ] && ok "case17: non-record paths clean (worktree == committed surface)" || bad "case17: unexpected residual changes: $(git -C "$WORK/c17" status --porcelain | tr '\n' '|')"

report
exit $?
