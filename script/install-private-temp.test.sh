#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/opencode-installer-test.XXXXXXXX")
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/fake-bin" "$test_root/archive" "$test_root/downloads"
printf '#!/bin/sh\nprintf "synthetic-version\\n"\n' > "$test_root/archive/opencode"
chmod +x "$test_root/archive/opencode"
tar -czf "$test_root/archive.tar.gz" -C "$test_root/archive" opencode

# Only redirect the install destination; run the remaining production installer verbatim.
sed 's|INSTALL_DIR=$HOME/.opencode/bin|INSTALL_DIR=$TEST_INSTALL_ROOT/bin|' "$repo_root/install" > "$test_root/install"
cat > "$test_root/fake-bin/uname" <<'EOF'
#!/bin/sh
case "$1" in -s) echo Linux ;; -m) echo aarch64 ;; esac
EOF
cat > "$test_root/fake-bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
head=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    -sI) head=true; shift ;;
    -o) output=$2; shift 2 ;;
    *) shift ;;
  esac
done
if [ "$head" = true ]; then printf 200; exit 0; fi
printf '%s\n' "$output" >> "$TEST_INSTALL_ROOT/paths"
if [ "${TEST_INSTALL_MODE:-success}" = fail ]; then printf partial > "$output"; exit 22; fi
if [ "${TEST_INSTALL_MODE:-success}" = interrupt ]; then
  printf partial > "$output"
  kill -TERM "$PPID"
  exit 22
fi
cp "$TEST_INSTALL_ARCHIVE" "$output"
EOF
chmod +x "$test_root/fake-bin/"*

for mode in success fail interrupt; do
  case_root="$test_root/$mode"
  mkdir -p "$case_root" "$case_root/tmp"
  printf untouched > "$case_root/sentinel"
  set +e
  TEST_INSTALL_ROOT="$case_root" TEST_INSTALL_ARCHIVE="$test_root/archive.tar.gz" TEST_INSTALL_MODE="$mode" \
    TMPDIR="$case_root/tmp" PATH="$test_root/fake-bin:$PATH" \
    bash -c 'mkdir -p "$TMPDIR/opencode_install_$$"; ln -s "$TEST_INSTALL_ROOT/sentinel" "$TMPDIR/opencode_install_$$/opencode-linux-arm64.tar.gz"; exec bash "$1" --version 99.0.0 --no-modify-path' _ "$test_root/install" \
    > "$case_root/output" 2>&1
  result=$?
  set -e
  test "$(cat "$case_root/sentinel")" = untouched
  if compgen -G "$case_root/tmp/opencode_install.*" >/dev/null; then
    echo "Temporary download directory survived $mode" >&2
    exit 1
  fi
  if [ "$mode" = success ]; then
    test "$result" -eq 0
    test "$("$case_root/bin/opencode")" = synthetic-version
  else
    test "$result" -ne 0
    test ! -e "$case_root/bin/opencode"
  fi
done
printf 'Private installer directory: success, failure, interrupt, and precreated symlink checks passed\n'
