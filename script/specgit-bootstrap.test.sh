#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/specgit-bootstrap-test.XXXXXX")
mkdir -p "$WORK/bin"
cat > "$WORK/bin/specgit" <<'STUB'
#!/bin/sh
if [ "$1" = --version ]; then
  printf '%s\n' "$TEST_VERSION"
  exit 0
fi
printf '%s\n' "$@" > "$TEST_ARGS"
exit "${TEST_EXIT:-0}"
STUB
chmod +x "$WORK/bin/specgit"
export PATH="$WORK/bin:$PATH" TEST_ARGS="$WORK/args" TEST_VERSION='specgit 2.0.0'
bash "$ROOT/script/specgit-bootstrap.sh" --title 'fix: quoted title' --body-file 'a path.md'
printf '%s\n' issue --title 'fix: quoted title' --body-file 'a path.md' > "$WORK/expected"
cmp "$WORK/expected" "$TEST_ARGS"
export TEST_EXIT=3
code=0
bash "$ROOT/script/specgit-bootstrap.sh" --dry-run || code=$?
[ "$code" = 3 ]
export TEST_VERSION=1.14.0 TEST_ARGS="$WORK/old-args"
code=0
bash "$ROOT/script/specgit-bootstrap.sh" --title 'must not run' 2> "$WORK/error" || code=$?
[ "$code" = 2 ]
[ ! -e "$TEST_ARGS" ]
grep -q 'SpecGit 2 is required' "$WORK/error"
printf '%s\n' 'PASS: v2 argument forwarding, exit propagation, v1 rejection'
