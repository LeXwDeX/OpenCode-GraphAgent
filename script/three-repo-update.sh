#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

CANON_R1="github.com/LeXwDeX/OpenCode-GraphAgent"
CANON_R2="github.com/LeXwDeX/SpecGit"
CANON_R3="github.com/LeXwDeX/opencode-dag-config"
CLONE_URL_R2="https://ghfast.top/https://github.com/LeXwDeX/SpecGit.git"
CLONE_URL_R3="https://ghfast.top/https://github.com/LeXwDeX/opencode-dag-config.git"

usage() {
  cat <<'EOF'
usage: three-repo-update.sh [--dry-run]

Syncs three repos locally (can_push=false: zero pushes, zero commits):
  1. OpenCode-GraphAgent   local main -> origin/main (fast-forward only)
  2. SpecGit               clone -> origin/main, build, install cli globally
  3. opencode-dag-config   clone -> origin/main, replicate root *.yaml to target

Options:
  --dry-run   detect and report pending transitions without applying changes
              (git fetch is still performed; exit 1 only on would-error)

Env overrides:
  R1_DIR      OpenCode-GraphAgent repo   (default: repo containing this script)
  R2_DIR      SpecGit clone              (default: /tmp/opencodeg/SpecGit)
  R3_DIR      opencode-dag-config clone  (default: /tmp/opencodeg/opencode-dag-config)
  R3_TARGET   workflow target directory  (default: ~/.config/opencodeg/workflows)
EOF
}

DRY_RUN=0
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
R1_DIR=${R1_DIR:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)}
R2_DIR=${R2_DIR:-/tmp/opencodeg/SpecGit}
R3_DIR=${R3_DIR:-/tmp/opencodeg/opencode-dag-config}
R3_TARGET=${R3_TARGET:-$HOME/.config/opencodeg/workflows}

RESULT_DIR=$(mktemp -d)
trap 'rm -rf "$RESULT_DIR"' EXIT

IDX="" NAME="" GUARD_REASON="" GUARD_DETAIL="" GUARD_AHEAD=0

progress() { printf '[%s/3] %s: %s\n' "$1" "$2" "$3"; }

error_status() { if (( DRY_RUN )); then echo would-error; else echo error; fi; }

describe_at() { git -C "$1" describe --tags --always "$2" 2>/dev/null || echo unknown; }

first_line() {
  local l=""
  if [[ -f ${1:-} ]]; then l=$(head -1 "$1" 2>/dev/null || true); fi
  if [[ -z $l ]]; then echo unknown; else echo "$l"; fi
}

normalize_url() {
  local u=$1
  u=${u%.git}
  if [[ $u == git@github.com:* ]]; then u="github.com/${u#git@github.com:}"; fi
  u=${u#https://}
  u=${u#http://}
  u=${u#ghfast.top/https://}
  u=${u#ghfast.top/http://}
  printf '%s' "${u%/}"
}

guard_identity() {
  local dir=$1 canonical=$2 url norm
  GUARD_REASON="" GUARD_DETAIL=""
  if [[ ! -d $dir ]]; then
    GUARD_DETAIL="directory missing"
    GUARD_REASON="directory missing"
    return 1
  fi
  if ! git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    GUARD_DETAIL="not a git repository"
    GUARD_REASON="exists but is not a matching clone; refusing to touch"
    return 1
  fi
  if ! url=$(git -C "$dir" remote get-url origin 2>/dev/null); then
    GUARD_DETAIL="no origin remote"
    GUARD_REASON="exists but is not a matching clone; refusing to touch"
    return 1
  fi
  norm=$(normalize_url "$url")
  if [[ $norm != "$canonical" ]]; then
    GUARD_DETAIL="origin url mismatch (got $norm, want $canonical)"
    GUARD_REASON="exists but is not a matching clone; refusing to touch"
    return 1
  fi
  return 0
}

guard_clean() {
  local dir=$1
  GUARD_REASON="" GUARD_DETAIL=""
  if [[ -n $(git -C "$dir" status --porcelain --untracked-files=no) ]]; then
    GUARD_DETAIL="tracked files dirty"
    GUARD_REASON="tracked files dirty; commit or stash first; refusing to reset"
    return 1
  fi
  return 0
}

ahead_count() { git -C "$1" rev-list --count "$2..$3" 2>/dev/null || echo 0; }

guard_not_ahead() {
  local dir=$1 upstream=$2 srcref=$3 label=$4
  GUARD_REASON="" GUARD_DETAIL="" GUARD_AHEAD=0
  GUARD_AHEAD=$(ahead_count "$dir" "$upstream" "$srcref")
  if [[ $GUARD_AHEAD -gt 0 ]]; then
    GUARD_DETAIL="$GUARD_AHEAD local commit(s) not in $upstream"
    GUARD_REASON="local $label has $GUARD_AHEAD commit(s) not in $upstream (never force-updated)"
    return 1
  fi
  return 0
}

meta() { printf '%s\n' "$1" >> "$RESULT_DIR/$IDX.result"; }

finish_repo() {
  local status=$1 version=$2 reason=${3:-}
  local display=$version
  if (( DRY_RUN )); then display="$version [dry-run]"; fi
  progress "$IDX" "$NAME" "status=$status"
  if [[ -n $reason ]]; then progress "$IDX" "$NAME" "reason: $reason"; fi
  progress "$IDX" "$NAME" "version $display"
  {
    echo "status=$status"
    echo "version=$version"
    if [[ -n $reason ]]; then echo "reason=$reason"; fi
  } > "$RESULT_DIR/$IDX.result"
}

detect_specgit_version() {
  local v=""
  v=$(specgit --version 2>/dev/null | head -1 || true)
  v=${v##* }
  if [[ -z $v ]]; then v=none; fi
  printf '%s' "$v"
}

repo_graphagent() {
  IDX=$1 NAME=$2
  local dir=$R1_DIR

  if ! guard_identity "$dir" "$CANON_R1"; then
    progress "$IDX" "$NAME" "guard failed: $GUARD_DETAIL"
    finish_repo "$(error_status)" "main unknown -> error" "$GUARD_REASON"
    return 0
  fi
  if ! git -C "$dir" rev-parse --verify --quiet refs/heads/main >/dev/null; then
    finish_repo "$(error_status)" "main unknown -> error" "local main branch missing"
    return 0
  fi

  local old_sha old_desc
  old_sha=$(git -C "$dir" rev-parse --short=7 refs/heads/main)
  old_desc=$(describe_at "$dir" refs/heads/main)
  progress "$IDX" "$NAME" "detecting current state (main=$old_sha, $old_desc)"

  if ! guard_not_ahead "$dir" origin/main refs/heads/main main; then
    progress "$IDX" "$NAME" "guard failed: $GUARD_DETAIL"
    finish_repo "$(error_status)" "main $old_sha -> error" "$GUARD_REASON"
    meta "ahead=$GUARD_AHEAD"
    return 0
  fi

  local upstream=""
  progress "$IDX" "$NAME" "fetching origin + tags"
  if timeout 60 git -C "$dir" fetch origin --tags 2>"$RESULT_DIR/r1-fetch.err"; then
    upstream=origin
  elif git -C "$dir" remote get-url ghfast >/dev/null 2>&1 && timeout 60 git -C "$dir" fetch ghfast --tags 2>>"$RESULT_DIR/r1-fetch.err"; then
    upstream=ghfast
    progress "$IDX" "$NAME" "origin unreachable; fetched ghfast + tags"
  else
    if git -C "$dir" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
      upstream=origin
    elif git -C "$dir" rev-parse --verify --quiet refs/remotes/ghfast/main >/dev/null; then
      upstream=ghfast
    fi
    if [[ -z $upstream ]]; then
      finish_repo "$(error_status)" "main $old_sha -> error" "offline: fetch failed and no local remote-tracking main ref"
      return 0
    fi
    progress "$IDX" "$NAME" "offline: fetch failed, using local $upstream/main"
  fi

  if ! guard_not_ahead "$dir" "$upstream/main" refs/heads/main main; then
    progress "$IDX" "$NAME" "guard: $GUARD_AHEAD commit(s) ahead of $upstream/main — refusing"
    finish_repo "$(error_status)" "main $old_sha -> error" "$GUARD_REASON"
    meta "ahead=$GUARD_AHEAD"
    return 0
  fi
  progress "$IDX" "$NAME" "guard: 0 commits ahead of $upstream/main — ok"

  local cur_main up_main new_sha
  cur_main=$(git -C "$dir" rev-parse refs/heads/main)
  up_main=$(git -C "$dir" rev-parse "refs/remotes/$upstream/main")
  new_sha=${up_main:0:7}

  if [[ $cur_main == "$up_main" ]]; then
    finish_repo "no-change" "main $new_sha -> no-update ($old_desc)"
    return 0
  fi

  local new_desc ncommits
  new_desc=$(describe_at "$dir" "refs/remotes/$upstream/main")
  ncommits=$(git -C "$dir" rev-list --count "refs/heads/main..refs/remotes/$upstream/main")

  if (( DRY_RUN )); then
    progress "$IDX" "$NAME" "would fast-forward main $old_sha -> $new_sha ($ncommits commits)"
    finish_repo "would-update" "main $old_sha -> $new_sha ($old_desc -> $new_desc)"
    meta "new_main_sha=$up_main"
    return 0
  fi

  progress "$IDX" "$NAME" "status=updating"
  local cur_branch
  cur_branch=$(git -C "$dir" symbolic-ref --short -q HEAD || echo "")
  if [[ $cur_branch == main ]]; then
    if ! git -C "$dir" merge --ff-only "refs/remotes/$upstream/main" 2>"$RESULT_DIR/r1-merge.err"; then
      finish_repo "$(error_status)" "main $old_sha -> error" "merge --ff-only failed on checked-out main: $(first_line "$RESULT_DIR/r1-merge.err")"
      return 0
    fi
    progress "$IDX" "$NAME" "fast-forward main $old_sha -> $new_sha ($ncommits commits; on main via ff-only merge)"
  else
    if git -C "$dir" worktree list --porcelain | grep -q '^branch refs/heads/main$'; then
      finish_repo "$(error_status)" "main $old_sha -> error" "main is checked out in a linked worktree; update it there"
      return 0
    fi
    git -C "$dir" update-ref refs/heads/main "$up_main"
    progress "$IDX" "$NAME" "fast-forward main $old_sha -> $new_sha ($ncommits commits; branch ${cur_branch:-detached}, worktree untouched)"
  fi
  finish_repo "updated" "main $old_sha -> $new_sha ($old_desc -> $new_desc)"
  meta "new_main_sha=$up_main"
  return 0
}

repo_specgit() {
  IDX=$1 NAME=$2
  local dir=$R2_DIR installed old_repo

  installed=$(detect_specgit_version)

  if [[ ! -d $dir ]]; then
    if (( DRY_RUN )); then
      progress "$IDX" "$NAME" "missing — real run would clone $CLONE_URL_R2"
      finish_repo "would-update" "repo unknown -> unknown; cli $installed -> unknown"
      return 0
    fi
    progress "$IDX" "$NAME" "cloning $CLONE_URL_R2"
    if ! git clone --quiet "$CLONE_URL_R2" "$dir" 2>"$RESULT_DIR/r2-clone.err"; then
      finish_repo "$(error_status)" "repo unknown; cli $installed -> error" "clone failed: $(first_line "$RESULT_DIR/r2-clone.err")"
      return 0
    fi
  fi

  if ! guard_identity "$dir" "$CANON_R2"; then
    progress "$IDX" "$NAME" "guard failed: $GUARD_DETAIL"
    finish_repo "$(error_status)" "repo unknown; cli $installed -> error" "$GUARD_REASON"
    return 0
  fi

  old_repo=$(git -C "$dir" rev-parse --short=7 HEAD)

  if ! guard_clean "$dir"; then
    progress "$IDX" "$NAME" "guard failed: $GUARD_DETAIL"
    finish_repo "$(error_status)" "repo $old_repo; cli $installed -> error" "$GUARD_REASON"
    return 0
  fi
  if ! guard_not_ahead "$dir" origin/main HEAD HEAD; then
    progress "$IDX" "$NAME" "guard failed: $GUARD_DETAIL"
    finish_repo "$(error_status)" "repo $old_repo; cli $installed -> error" "$GUARD_REASON"
    return 0
  fi

  progress "$IDX" "$NAME" "detecting current state (repo $old_repo, cli $installed)"
  progress "$IDX" "$NAME" "fetching origin + tags"
  if ! git -C "$dir" fetch origin --tags 2>"$RESULT_DIR/r2-fetch.err"; then
    finish_repo "$(error_status)" "repo $old_repo; cli $installed -> error" "fetch failed: $(first_line "$RESULT_DIR/r2-fetch.err")"
    return 0
  fi
  if ! guard_not_ahead "$dir" origin/main HEAD HEAD; then
    progress "$IDX" "$NAME" "guard failed after fetch: $GUARD_DETAIL"
    finish_repo "$(error_status)" "repo $old_repo; cli $installed -> error" "$GUARD_REASON"
    return 0
  fi
  progress "$IDX" "$NAME" "guard: origin url ok, tracked-clean, 0 local commits — ok"

  local head_full origin_full pkg_json pkg_name pkg_version
  head_full=$(git -C "$dir" rev-parse HEAD)
  origin_full=$(git -C "$dir" rev-parse refs/remotes/origin/main)
  if ! pkg_json=$(git -C "$dir" show origin/main:package.json 2>"$RESULT_DIR/r2-show.err"); then
    finish_repo "$(error_status)" "repo $old_repo; cli $installed -> error" "cannot read origin/main:package.json: $(first_line "$RESULT_DIR/r2-show.err")"
    return 0
  fi
  pkg_name=$(printf '%s' "$pkg_json" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).name')
  pkg_version=$(printf '%s' "$pkg_json" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')

  if [[ $head_full == "$origin_full" && $installed == "$pkg_version" ]]; then
    finish_repo "no-change" "repo $old_repo; cli $installed -> no-update"
    return 0
  fi

  local new7 repo_part cli_part
  new7=${origin_full:0:7}
  if [[ $head_full != "$origin_full" ]]; then repo_part="repo $old_repo -> $new7"; else repo_part="repo $old_repo (no-change)"; fi
  if [[ $installed != "$pkg_version" ]]; then cli_part="cli $installed -> $pkg_version"; else cli_part="cli $pkg_version (no-change)"; fi

  if (( DRY_RUN )); then
    if [[ $head_full != "$origin_full" ]]; then
      progress "$IDX" "$NAME" "would reset repo $old_repo -> $new7, then build + install cli $pkg_version"
    else
      progress "$IDX" "$NAME" "repo already at origin/main ($old_repo); would build + install cli $pkg_version"
    fi
    finish_repo "would-update" "$repo_part; $cli_part"
    meta "cli_new=$pkg_version"
    return 0
  fi

  progress "$IDX" "$NAME" "status=updating"
  if [[ $head_full != "$origin_full" ]]; then
    git -C "$dir" reset --hard refs/remotes/origin/main
    progress "$IDX" "$NAME" "repo $old_repo -> $new7 (reset to origin/main)"
  else
    progress "$IDX" "$NAME" "repo already at origin/main ($old_repo); building + installing cli"
  fi
  progress "$IDX" "$NAME" "pnpm install --frozen-lockfile (prepare -> build) [cwd=$dir]"
  if ! ( cd "$dir" && pnpm install --frozen-lockfile ) >"$RESULT_DIR/r2-pnpm-install.log" 2>&1; then
    finish_repo "$(error_status)" "repo $old_repo; cli $installed -> error" "pnpm install --frozen-lockfile failed: $(tail -1 "$RESULT_DIR/r2-pnpm-install.log" 2>/dev/null || echo unknown)"
    return 0
  fi
  local pack_dir pack_out tarball
  pack_dir=$(mktemp -d "$RESULT_DIR/pack.XXXXXX")
  if ! pack_out=$( cd "$dir" && pnpm pack --pack-destination "$pack_dir" 2>&1 ); then
    finish_repo "$(error_status)" "repo $old_repo; cli $installed -> error" "pnpm pack failed: $(printf '%s\n' "$pack_out" | tail -1)"
    return 0
  fi
  tarball="$pack_dir/$pkg_name-$pkg_version.tgz"
  if [[ ! -f $tarball || $pack_out != *"$pkg_name-$pkg_version.tgz"* ]]; then
    finish_repo "$(error_status)" "repo $old_repo; cli $installed -> error" "pnpm pack did not produce expected $pkg_name-$pkg_version.tgz"
    return 0
  fi
  progress "$IDX" "$NAME" "pnpm pack -> $pkg_name-$pkg_version.tgz; npm install -g"
  if ! npm install -g "$tarball" >"$RESULT_DIR/r2-npm-install.log" 2>&1; then
    finish_repo "$(error_status)" "repo $old_repo; cli $installed -> error" "npm install -g failed: $(tail -1 "$RESULT_DIR/r2-npm-install.log" 2>/dev/null || echo unknown)"
    return 0
  fi
  local verify
  verify=$(detect_specgit_version)
  if [[ $verify != "$pkg_version" ]]; then
    finish_repo "$(error_status)" "repo $old_repo; cli $installed -> error" "post-install version mismatch (specgit --version=$verify, expected $pkg_version)"
    return 0
  fi
  progress "$IDX" "$NAME" "cli $verify installed globally"
  finish_repo "updated" "$repo_part; $cli_part"
  meta "cli_new=$pkg_version"
  return 0
}

repo_dagconfig() {
  IDX=$1 NAME=$2
  local dir=$R3_DIR target=$R3_TARGET

  local old_sync=none s=""
  if [[ -f $target/.three-repo-update-state ]]; then
    s=$(sed -n 's/^last_synced=//p' "$target/.three-repo-update-state" | head -1 || true)
    if [[ -n $s ]]; then old_sync=$s; fi
  fi
  local old_sync_disp
  if [[ $old_sync == none ]]; then old_sync_disp=none; else old_sync_disp=${old_sync:0:7}; fi

  if [[ ! -d $dir ]]; then
    if (( DRY_RUN )); then
      progress "$IDX" "$NAME" "missing — real run would clone $CLONE_URL_R3"
      finish_repo "would-update" "sync $old_sync_disp -> unknown"
      return 0
    fi
    progress "$IDX" "$NAME" "cloning $CLONE_URL_R3"
    if ! git clone --quiet "$CLONE_URL_R3" "$dir" 2>"$RESULT_DIR/r3-clone.err"; then
      finish_repo "$(error_status)" "sync $old_sync_disp -> error" "clone failed: $(first_line "$RESULT_DIR/r3-clone.err")"
      return 0
    fi
  fi

  if ! guard_identity "$dir" "$CANON_R3"; then
    progress "$IDX" "$NAME" "guard failed: $GUARD_DETAIL"
    finish_repo "$(error_status)" "sync $old_sync_disp -> error" "$GUARD_REASON"
    return 0
  fi

  local old_head
  old_head=$(git -C "$dir" rev-parse --short=7 HEAD)

  if ! guard_clean "$dir"; then
    progress "$IDX" "$NAME" "guard failed: $GUARD_DETAIL"
    finish_repo "$(error_status)" "sync $old_sync_disp -> error" "$GUARD_REASON"
    return 0
  fi
  if ! guard_not_ahead "$dir" origin/main HEAD HEAD; then
    progress "$IDX" "$NAME" "guard failed: $GUARD_DETAIL"
    finish_repo "$(error_status)" "sync $old_sync_disp -> error" "$GUARD_REASON"
    return 0
  fi

  progress "$IDX" "$NAME" "detecting current state (repo $old_head, target last-synced $old_sync_disp)"
  progress "$IDX" "$NAME" "fetching origin + tags"
  if ! git -C "$dir" fetch origin --tags 2>"$RESULT_DIR/r3-fetch.err"; then
    finish_repo "$(error_status)" "sync $old_sync_disp -> error" "fetch failed: $(first_line "$RESULT_DIR/r3-fetch.err")"
    return 0
  fi
  if ! guard_not_ahead "$dir" origin/main HEAD HEAD; then
    progress "$IDX" "$NAME" "guard failed after fetch: $GUARD_DETAIL"
    finish_repo "$(error_status)" "sync $old_sync_disp -> error" "$GUARD_REASON"
    return 0
  fi
  progress "$IDX" "$NAME" "guard: origin url ok, tracked-clean, 0 local commits — ok"

  local head_full origin_full origin7 repo_moved=0
  head_full=$(git -C "$dir" rev-parse HEAD)
  origin_full=$(git -C "$dir" rev-parse refs/remotes/origin/main)
  origin7=${origin_full:0:7}
  if [[ $head_full != "$origin_full" ]]; then repo_moved=1; fi

  local -a yamls=()
  mapfile -t yamls < <(git -C "$dir" ls-tree --name-only origin/main | grep '\.yaml$' | sort)

  local scratch
  scratch=$(mktemp -d "$RESULT_DIR/r3.XXXXXX")
  local U=0 N=0 K=0 f
  local -a news=() updates=()
  for f in "${yamls[@]}"; do
    git -C "$dir" show "origin/main:$f" > "$scratch/$f"
    if [[ ! -f $target/$f ]]; then
      N=$((N+1)); news+=("$f")
    elif cmp -s "$scratch/$f" "$target/$f"; then
      K=$((K+1))
    else
      U=$((U+1)); updates+=("$f")
    fi
  done

  if (( DRY_RUN )); then
    if (( repo_moved )); then progress "$IDX" "$NAME" "would reset clone $old_head -> $origin7"; fi
    for f in "${news[@]}"; do progress "$IDX" "$NAME" "would add $f (new)"; done
    for f in "${updates[@]}"; do progress "$IDX" "$NAME" "would update $f"; done
    if (( U + N > 0 )) || (( repo_moved )); then
      finish_repo "would-update" "sync $old_sync_disp -> $origin7 ($U updated, $N new, $K unchanged)"
    else
      finish_repo "no-change" "sync $origin7 -> no-update ($U updated, $N new, $K unchanged)"
    fi
    meta "origin7=$origin7"
    return 0
  fi

  if (( U + N == 0 )) && (( repo_moved == 0 )); then
    if [[ $old_sync != "$origin_full" && -d $target ]]; then
      printf 'last_synced=%s\n' "$origin_full" > "$target/.three-repo-update-state"
    fi
    finish_repo "no-change" "sync $origin7 -> no-update ($U updated, $N new, $K unchanged)"
    return 0
  fi

  progress "$IDX" "$NAME" "status=updating"
  if (( repo_moved )); then
    git -C "$dir" reset --hard refs/remotes/origin/main
    progress "$IDX" "$NAME" "repo $old_head -> $origin7 (reset to origin/main)"
  fi
  progress "$IDX" "$NAME" "syncing ${#yamls[@]} yamls -> target"
  mkdir -p "$target"
  if [[ -d $target/.git ]]; then
    mkdir -p "$target/.git/info"
    local e
    for e in ".backups/" ".three-repo-update-state"; do
      if ! grep -qxF "$e" "$target/.git/info/exclude" 2>/dev/null; then
        printf '%s\n' "$e" >> "$target/.git/info/exclude"
      fi
    done
  fi
  local ts
  ts=$(date +%Y%m%d-%H%M%S)
  for f in "${news[@]}"; do
    cp "$scratch/$f" "$target/$f"
    progress "$IDX" "$NAME" "NEW $f"
  done
  for f in "${updates[@]}"; do
    mkdir -p "$target/.backups/$ts"
    cp "$target/$f" "$target/.backups/$ts/$f"
    cp "$scratch/$f" "$target/$f"
    progress "$IDX" "$NAME" "UPDATE $f (backed up to .backups/$ts/)"
  done
  printf 'last_synced=%s\n' "$origin_full" > "$target/.three-repo-update-state"
  finish_repo "updated" "sync $old_sync_disp -> $origin7 ($U updated, $N new, $K unchanged)"
  meta "origin7=$origin7"
  return 0
}

run_repo() {
  local idx=$1 name=$2 fn=$3 rc=0
  rm -f "$RESULT_DIR/$idx.result"
  ( set -Eeuo pipefail
    trap 'progress "$idx" "$name" "error: command failed (line $LINENO, exit $?)"' ERR
    "$fn" "$idx" "$name"
  ) || rc=$?
  if [[ ! -f $RESULT_DIR/$idx.result ]]; then
    local status version display
    status=$(error_status)
    case $idx in
      1) version="main unknown -> error" ;;
      2) version="repo unknown; cli unknown -> error" ;;
      *) version="sync none -> error" ;;
    esac
    display=$version
    if (( DRY_RUN )); then display="$version [dry-run]"; fi
    progress "$idx" "$name" "status=$status"
    progress "$idx" "$name" "reason: crashed (exit $rc)"
    progress "$idx" "$name" "version $display"
    {
      echo "status=$status"
      echo "version=$version"
      echo "reason=crashed (exit $rc)"
    } > "$RESULT_DIR/$idx.result"
  fi
}

if (( DRY_RUN )); then echo "== three-repo-update --dry-run =="; else echo "== three-repo-update =="; fi

run_repo 1 OpenCode-GraphAgent repo_graphagent
run_repo 2 SpecGit repo_specgit
run_repo 3 opencode-dag-config repo_dagconfig

NAMES=(dummy OpenCode-GraphAgent SpecGit opencode-dag-config)
STATUS=(dummy "" "" "")
VERSIONS=(dummy "" "" "")
REASONS=(dummy "" "" "")
for i in 1 2 3; do
  STATUS[$i]=$(sed -n 's/^status=//p' "$RESULT_DIR/$i.result" | head -1)
  VERSIONS[$i]=$(sed -n 's/^version=//p' "$RESULT_DIR/$i.result" | head -1)
  REASONS[$i]=$(sed -n 's/^reason=//p' "$RESULT_DIR/$i.result" | head -1)
done

echo
echo "== summary =="
printf '%-22s %-13s %s\n' REPO STATUS VERSION
for i in 1 2 3; do
  v=${VERSIONS[$i]}
  if (( DRY_RUN )); then v="$v [dry-run]"; fi
  printf '%-22s %-13s %s\n' "${NAMES[$i]}" "${STATUS[$i]}" "$v"
done

cnt_change=0 cnt_nochange=0 cnt_error=0
for i in 1 2 3; do
  case ${STATUS[$i]} in
    updated|would-update) cnt_change=$((cnt_change+1)) ;;
    no-change) cnt_nochange=$((cnt_nochange+1)) ;;
    *) cnt_error=$((cnt_error+1)) ;;
  esac
done
ec=0
if (( cnt_error > 0 )); then ec=1; fi
if (( DRY_RUN )); then
  echo "result: exit=$ec would-update=$cnt_change no-change=$cnt_nochange would-error=$cnt_error"
else
  echo "result: exit=$ec updated=$cnt_change no-change=$cnt_nochange error=$cnt_error"
fi

get_meta() { sed -n "s/^$2=//p" "$RESULT_DIR/$1.result" | head -1; }

echo
echo "== human follow-up (can_push=false: nothing was pushed) =="
if (( DRY_RUN )); then echo "(dry-run: no changes applied; steps below describe what the real run would require)"; fi
step_n=0
emit() { step_n=$((step_n+1)); printf '%s. %s\n' "$step_n" "$1"; }

if [[ ${STATUS[1]} == error || ${STATUS[1]} == would-error ]]; then
  ahead=$(get_meta 1 ahead)
  if [[ -n $ahead ]]; then
    emit "OpenCode-GraphAgent: local main has $ahead commit(s) not in origin/main (never force-updated). Resolve, then re-run:
     git -C $R1_DIR push origin main              # if purely ahead
     git -C $R1_DIR pull --rebase origin main     # if diverged"
  elif [[ ${REASONS[1]} == *"merge --ff-only"* ]]; then
    emit "OpenCode-GraphAgent: ff-only merge on checked-out main failed; commit or stash the worktree on main, then re-run."
  else
    emit "OpenCode-GraphAgent: resolve error: ${REASONS[1]}"
  fi
fi
if [[ ${STATUS[2]} == updated || ${STATUS[2]} == would-update ]]; then
  emit "SpecGit: cli $(get_meta 2 cli_new) installed globally from local tarball (build mirror — nothing to push unless you made local changes)."
elif [[ ${STATUS[2]} == error || ${STATUS[2]} == would-error ]]; then
  emit "SpecGit: resolve error: ${REASONS[2]}"
fi
if [[ ${STATUS[3]} == updated || ${STATUS[3]} == would-update ]]; then
  emit "opencode-dag-config target: commit synced workflows locally (NO remote — push impossible):
     git -C $R3_TARGET add -A -- '*.yaml' && git -C $R3_TARGET commit -m \"chore: sync workflows from opencode-dag-config@$(get_meta 3 origin7)\"
   (.backups/ and .three-repo-update-state are excluded via .git/info/exclude — add -A is safe)"
elif [[ ${STATUS[3]} == error || ${STATUS[3]} == would-error ]]; then
  emit "opencode-dag-config: resolve error: ${REASONS[3]}"
fi
if [[ ${STATUS[1]} == updated || ${STATUS[1]} == would-update ]]; then
  emit "opencode-dag-config clone: bump runtime-compat.json runtime SHA to $(get_meta 1 new_main_sha) (new R1 main HEAD) and open PR (printed, never executed)"
fi
if (( step_n == 0 )); then echo "none — all three repos are in sync."; fi

exit $ec
