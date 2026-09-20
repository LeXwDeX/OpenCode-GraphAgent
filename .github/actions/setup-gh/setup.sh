#!/usr/bin/env bash

set -euo pipefail

: "${GH_CLI_VERSION:?GH_CLI_VERSION is required}"
: "${GH_CLI_LINUX_AMD64_SHA256:?GH_CLI_LINUX_AMD64_SHA256 is required}"
: "${GH_CLI_WINDOWS_AMD64_SHA256:?GH_CLI_WINDOWS_AMD64_SHA256 is required}"
: "${GH_CLI_DOWNLOAD_BASE_URL:?GH_CLI_DOWNLOAD_BASE_URL is required}"
: "${RUNNER_OS:?RUNNER_OS is required}"
: "${RUNNER_ARCH:?RUNNER_ARCH is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

to_posix_path() {
  if [ "$RUNNER_OS" = "Windows" ] && command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$1"
  else
    printf '%s\n' "$1"
  fi
}

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "::error::A SHA-256 tool (sha256sum, shasum, or openssl) is required." >&2
    return 1
  fi
}

case "$RUNNER_OS:$RUNNER_ARCH" in
  Linux:X64)
    asset="gh_${GH_CLI_VERSION}_linux_amd64.tar.gz"
    expected="$GH_CLI_LINUX_AMD64_SHA256"
    member="gh_${GH_CLI_VERSION}_linux_amd64/bin/gh"
    installed_name="gh"
    ;;
  Windows:X64)
    asset="gh_${GH_CLI_VERSION}_windows_amd64.zip"
    expected="$GH_CLI_WINDOWS_AMD64_SHA256"
    member="bin/gh.exe"
    installed_name="gh.exe"
    ;;
  *)
    echo "::error::Unsupported GitHub CLI bootstrap platform: $RUNNER_OS/$RUNNER_ARCH" >&2
    exit 1
    ;;
esac

runner_temp="$(to_posix_path "$RUNNER_TEMP")"
github_path_file="$(to_posix_path "$GITHUB_PATH")"
download_dir="$(mktemp -d "$runner_temp/gh-cli-download.XXXXXX")"
install_dir="$(mktemp -d "$runner_temp/gh-cli-install.XXXXXX")"
trap 'rm -rf "$download_dir"' EXIT

archive="$download_dir/$asset"
extract_dir="$download_dir/extract"
mkdir -p "$extract_dir" "$install_dir/bin"

curl --fail --location --silent --show-error \
  --connect-timeout 20 --max-time 300 --retry 3 --retry-delay 1 \
  --output "$archive" "$GH_CLI_DOWNLOAD_BASE_URL/$asset"

actual="$(digest "$archive")"
if [ "$actual" != "$expected" ]; then
  echo "::error::GitHub CLI archive checksum mismatch for $asset: expected $expected, got $actual" >&2
  exit 1
fi

case "$RUNNER_OS" in
  Linux) tar -xzf "$archive" -C "$extract_dir" ;;
  Windows)
    archive_windows="$(cygpath -w "$archive")"
    extract_dir_windows="$(cygpath -w "$extract_dir")"
    dollar='$'
    powershell_command="${dollar}ErrorActionPreference = \"Stop\"; Expand-Archive -LiteralPath ${dollar}env:GH_CLI_ARCHIVE_WINDOWS -DestinationPath ${dollar}env:GH_CLI_EXTRACT_WINDOWS -Force"
    GH_CLI_ARCHIVE_WINDOWS="$archive_windows" \
      GH_CLI_EXTRACT_WINDOWS="$extract_dir_windows" \
      powershell.exe -NoLogo -NoProfile -NonInteractive -Command \
        "$powershell_command"
    ;;
esac

source_binary="$extract_dir/$member"
if [ ! -f "$source_binary" ]; then
  echo "::error::GitHub CLI archive is missing expected member: $member" >&2
  exit 1
fi

installed_binary="$install_dir/bin/$installed_name"
cp "$source_binary" "$installed_binary"
chmod +x "$installed_binary"

path_entry="$install_dir/bin"
if [ "$RUNNER_OS" = "Windows" ] && command -v cygpath >/dev/null 2>&1; then
  path_entry="$(cygpath -w "$path_entry")"
fi
printf '%s\n' "$path_entry" >> "$github_path_file"

"$installed_binary" --version
