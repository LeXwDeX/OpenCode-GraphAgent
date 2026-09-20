#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SETUP="$ROOT/.github/actions/setup-gh/setup.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/setup-gh-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

version="0.0.0-test"
assets="$TMP/assets"
mkdir -p "$assets/linux/gh_${version}_linux_amd64/bin" "$assets/windows/bin"

cat > "$assets/linux/gh_${version}_linux_amd64/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "gh version fixture-linux"
EOF
chmod +x "$assets/linux/gh_${version}_linux_amd64/bin/gh"
tar -czf "$assets/gh_${version}_linux_amd64.tar.gz" -C "$assets/linux" "gh_${version}_linux_amd64"

cat > "$assets/windows/bin/gh.exe" <<'EOF'
#!/usr/bin/env bash
echo "gh version fixture-windows"
EOF
chmod +x "$assets/windows/bin/gh.exe"
WINDOWS_FIXTURE_DIR="$assets/windows" WINDOWS_FIXTURE_ZIP="$assets/gh_${version}_windows_amd64.zip" python3 - <<'PY'
import os
import pathlib
import zipfile

root = pathlib.Path(os.environ["WINDOWS_FIXTURE_DIR"])
with zipfile.ZipFile(os.environ["WINDOWS_FIXTURE_ZIP"], "w", zipfile.ZIP_DEFLATED) as archive:
    archive.write(root / "bin" / "gh.exe", "bin/gh.exe")
PY

linux_sha="$(digest "$assets/gh_${version}_linux_amd64.tar.gz")"
windows_sha="$(digest "$assets/gh_${version}_windows_amd64.zip")"

run_setup() {
  local os="$1"
  local runner_temp="$TMP/run-$os space"
  local github_path="$TMP/github-path-$os space"
  mkdir -p "$runner_temp"
  : > "$github_path"
  env \
    GH_CLI_VERSION="$version" \
    GH_CLI_LINUX_AMD64_SHA256="$linux_sha" \
    GH_CLI_WINDOWS_AMD64_SHA256="$windows_sha" \
    GH_CLI_DOWNLOAD_BASE_URL="file://$assets" \
    RUNNER_OS="$os" \
    RUNNER_ARCH=X64 \
    RUNNER_TEMP="$runner_temp" \
    GITHUB_PATH="$github_path" \
    bash "$SETUP"
}

mock_bin="$TMP/mock-bin"
mkdir -p "$mock_bin"
cat > "$mock_bin/cygpath" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  -u|-w) printf '%s\n' "$2" ;;
  *) exit 2 ;;
esac
EOF
cat > "$mock_bin/powershell.exe" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'Expand-Archive -LiteralPath $env:GH_CLI_ARCHIVE_WINDOWS -DestinationPath $env:GH_CLI_EXTRACT_WINDOWS -Force'*) ;;
  *) echo "unexpected PowerShell extraction command: $*" >&2; exit 2 ;;
esac
python3 - <<'PY'
import os
import zipfile

with zipfile.ZipFile(os.environ["GH_CLI_ARCHIVE_WINDOWS"]) as archive:
    archive.extractall(os.environ["GH_CLI_EXTRACT_WINDOWS"])
PY
EOF
chmod +x "$mock_bin/cygpath" "$mock_bin/powershell.exe"

linux_output="$(run_setup Linux)"
grep -q "gh version fixture-linux" <<< "$linux_output"
linux_bin="$(cat "$TMP/github-path-Linux space")/gh"
test -x "$linux_bin"

windows_output="$(PATH="$mock_bin:$PATH" run_setup Windows)"
grep -q "gh version fixture-windows" <<< "$windows_output"
windows_bin="$(cat "$TMP/github-path-Windows space")/gh.exe"
test -x "$windows_bin"

bad_log="$TMP/bad-checksum.log"
if env \
  GH_CLI_VERSION="$version" \
  GH_CLI_LINUX_AMD64_SHA256="$(printf '0%.0s' {1..64})" \
  GH_CLI_WINDOWS_AMD64_SHA256="$windows_sha" \
  GH_CLI_DOWNLOAD_BASE_URL="file://$assets" \
  RUNNER_OS=Linux \
  RUNNER_ARCH=X64 \
  RUNNER_TEMP="$TMP" \
  GITHUB_PATH="$TMP/bad-github-path" \
  bash "$SETUP" > "$bad_log" 2>&1; then
  echo "checksum mismatch unexpectedly succeeded" >&2
  exit 1
fi
grep -q "archive checksum mismatch" "$bad_log"
test ! -e "$TMP/bad-github-path"

unsupported_log="$TMP/unsupported.log"
if env \
  GH_CLI_VERSION="$version" \
  GH_CLI_LINUX_AMD64_SHA256="$linux_sha" \
  GH_CLI_WINDOWS_AMD64_SHA256="$windows_sha" \
  GH_CLI_DOWNLOAD_BASE_URL="file://$assets" \
  RUNNER_OS=macOS \
  RUNNER_ARCH=ARM64 \
  RUNNER_TEMP="$TMP" \
  GITHUB_PATH="$TMP/unsupported-github-path" \
  bash "$SETUP" > "$unsupported_log" 2>&1; then
  echo "unsupported platform unexpectedly succeeded" >&2
  exit 1
fi
grep -q "Unsupported GitHub CLI bootstrap platform: macOS/ARM64" "$unsupported_log"
test ! -e "$TMP/unsupported-github-path"

echo "setup-gh: linux/windows positive, checksum failure, and unsupported platform passed"
