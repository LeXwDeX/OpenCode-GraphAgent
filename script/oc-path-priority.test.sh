#!/usr/bin/env bash
# Zero-network regression test for oc's PATH-aware default install selection.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OC="$ROOT/oc"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/oc-path-priority.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'FAIL - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok   - %s\n' "$1"; }

HOME="$WORK/home with spaces"
LOCAL_BIN="$HOME/.local/bin"
SYSTEM_BIN="$WORK/usr-local-bin"
SHADOW_BIN="$WORK/shadow-bin"
FRESH_HOME="$WORK/fresh home with spaces"
FRESH_LOCAL_BIN="$FRESH_HOME/.local/bin"
SYMLINK_BIN="$WORK/symlink-bin"
mkdir -p "$LOCAL_BIN" "$SYSTEM_BIN" "$SHADOW_BIN" "$SYMLINK_BIN" "$WORK/stubs" "$WORK/payload"

# Use a private source copy with /usr/local/bin redirected to a sandbox path.
# This exercises both supported-directory branches without touching the host.
sed "s|/usr/local/bin|$SYSTEM_BIN|g" "$OC" > "$WORK/oc"
TEST_OC="$WORK/oc"
printf '#!/bin/sh\nprintf "old-system\\n"\n' > "$SYSTEM_BIN/opencode"
chmod +x "$SYSTEM_BIN/opencode"

cat > "$WORK/payload/opencode" <<'EOF'
#!/bin/sh
printf '9.9.8-path-priority\n'
EOF
chmod +x "$WORK/payload/opencode"
tar -czf "$WORK/release.tar.gz" -C "$WORK/payload" opencode

# Source-only operation needs fzf only when the TUI is invoked; provide a stub
# so this remains independent of the host's installed tools.
printf '#!/bin/sh\nexit 0\n' > "$WORK/stubs/fzf"
chmod +x "$WORK/stubs/fzf"

(
  export HOME
  export PATH="$WORK/stubs:$SYSTEM_BIN:$LOCAL_BIN:$PATH"
  unset OC_INSTALL_DIR || true
  # Current system install is preserved even when HOME/.local/bin is absent
  # from the effective install choice; update that active binary in place.
  source "$TEST_OC"
  [ "$INSTALL_DIR" = "$SYSTEM_BIN" ] || fail "active system install is selected"
  tmp="$WORK/extract"
  mkdir -p "$tmp"
  extract_and_install "$WORK/release.tar.gz" "$tmp"
  [ "$(current_version)" = "9.9.8-path-priority" ] || fail "current_version reads installed PATH winner"
  check_active_install >/dev/null || fail "selected target is active"
  pass "active system install is updated and current_version follows PATH"
)

# A stale active home install wins over a newer binary in the later system
# directory and is refreshed in place.
printf '#!/bin/sh\nprintf "old-local\\n"\n' > "$LOCAL_BIN/opencode"
chmod +x "$LOCAL_BIN/opencode"
(
  export HOME
  export PATH="$WORK/stubs:$LOCAL_BIN:$SYSTEM_BIN:$PATH"
  unset OC_INSTALL_DIR || true
  source "$TEST_OC"
  [ "$INSTALL_DIR" = "$LOCAL_BIN" ] || fail "active home install is selected"
  tmp="$WORK/extract-home"
  mkdir -p "$tmp"
  extract_and_install "$WORK/release.tar.gz" "$tmp"
  [ "$(current_version)" = "9.9.8-path-priority" ] || fail "home install version is updated"
  check_active_install >/dev/null || fail "home target is active"
  pass "active home install is refreshed ahead of later system binary"
)

# With neither supported path populated, a fresh install follows PATH order.
rm -f "$SYSTEM_BIN/opencode"
(
  export HOME="$FRESH_HOME"
  export PATH="$WORK/stubs:$FRESH_LOCAL_BIN:$SYSTEM_BIN:$PATH"
  unset OC_INSTALL_DIR || true
  source "$TEST_OC"
  [ "$INSTALL_DIR" = "$FRESH_LOCAL_BIN" ] || fail "fresh install selects first supported PATH directory"
  tmp="$WORK/extract-fresh"
  mkdir -p "$tmp"
  extract_and_install "$WORK/release.tar.gz" "$tmp"
  [ "$(current_version)" = "9.9.8-path-priority" ] || fail "fresh install reports packaged version"
  check_active_install >/dev/null || fail "fresh target is active"
  pass "fresh install selects PATH-first directory with HOME containing spaces"
)

# An explicitly selected target must fail if an earlier PATH entry shadows it.
printf '#!/bin/sh\nprintf "shadow\\n"\n' > "$SHADOW_BIN/opencode"
chmod +x "$SHADOW_BIN/opencode"
(
  export HOME
  export PATH="$WORK/stubs:$SHADOW_BIN:$LOCAL_BIN:$SYSTEM_BIN:$PATH"
  export OC_INSTALL_DIR="$LOCAL_BIN"
  source "$TEST_OC"
  if check_active_install >/dev/null 2>&1; then
    fail "explicit target detects an earlier shadowing binary"
  fi
  pass "explicit target rejects earlier PATH shadow"
)

# Installer must refuse to replace a symlink at an explicit target.
printf '#!/bin/sh\nprintf "keep-me\\n"\n' > "$WORK/keep-opencode"
chmod +x "$WORK/keep-opencode"
ln -s "$WORK/keep-opencode" "$SYMLINK_BIN/opencode"
if (
  export HOME
  export PATH="$WORK/stubs:$SYMLINK_BIN:$LOCAL_BIN:$SYSTEM_BIN:$PATH"
  export OC_INSTALL_DIR="$SYMLINK_BIN"
  source "$TEST_OC"
  mkdir -p "$WORK/extract-symlink"
  extract_and_install "$WORK/release.tar.gz" "$WORK/extract-symlink"
) >/dev/null 2>&1; then
  fail "installer rejects symlink target"
fi
[ -L "$SYMLINK_BIN/opencode" ] || fail "symlink target remains intact"
pass "installer rejects symlink target without replacing it"

printf '\n5 passed, 0 failed\n'
