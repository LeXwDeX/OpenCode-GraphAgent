#!/bin/sh
# SpecGit merge guard (managed by specgit init). Exit 2 = block with reason.
command=$(printf '%s' "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&j.tool_input.command)||'')}catch{process.stdout.write('')}})")

case "$command" in
  gh\ pr\ merge*)
    # Real-time verdict: re-evaluate the delivery before letting a merge
    # through. Verdicts are never persisted, so compute one now.
    if specgit finish >/dev/null 2>&1; then
      exit 0
    fi
    echo "specgit: merge blocked - 'specgit finish' does not exit 0 right now. Fix what the failures name; never weaken spec_git/policy.yaml to pass." >&2
    exit 2
    ;;
  git\ push\ origin\ main*|git\ push\ origin\ +main*|git\ push\ origin\ HEAD:main*)
    echo "specgit: direct push to main is not the delivery path. Deliveries go: specgit issue -> PR -> CI -> specgit finish (exit 0) -> merge." >&2
    exit 2
    ;;
esac
exit 0
