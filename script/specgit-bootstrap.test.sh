#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/specgit-bootstrap-test.XXXXXX")
# Validate the installed v2 parser offline before replacing it with a stub.
specgit issue 'fix: quoted title' --body-file 'a path.md' --inspect --schema > "$WORK/schema.json"
python3 - "$WORK/schema.json" <<'PYTHON'
import json
import sys
with open(sys.argv[1]) as source:
    report = json.load(source)
assert report["schema_version"] == 2 and report["ok"]
issue = report["evidence"]["command"]
assert issue["name"] == "issue"
assert any(argument["id"] == "specs" and argument["position"] == 1 for argument in issue["arguments"])
assert not any(argument["long"] == "title" for argument in issue["arguments"])
PYTHON
code=0
specgit issue --title 'fix: retired syntax' --inspect > "$WORK/invalid.json" || code=$?
[ "$code" = 2 ]
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
bash "$ROOT/script/specgit-bootstrap.sh" 'fix: quoted title' --body-file 'a path.md'
printf '%s\n' issue 'fix: quoted title' --body-file 'a path.md' > "$WORK/expected"
cmp "$WORK/expected" "$TEST_ARGS"
export TEST_EXIT=3
code=0
bash "$ROOT/script/specgit-bootstrap.sh" 123 --dry-run || code=$?
[ "$code" = 3 ]
export TEST_VERSION=1.14.0 TEST_ARGS="$WORK/old-args"
code=0
bash "$ROOT/script/specgit-bootstrap.sh" 'fix: must not run' 2> "$WORK/error" || code=$?
[ "$code" = 2 ]
[ ! -e "$TEST_ARGS" ]
grep -q 'SpecGit 2 is required' "$WORK/error"
printf '%s\n' 'PASS: installed parser schema regression, v2 positional forwarding, exit propagation, v1 rejection'
