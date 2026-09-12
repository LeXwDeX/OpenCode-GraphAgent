#!/bin/sh
# Compatibility entrypoint for existing callers. SpecGit 2 owns validation.
set -eu
case "$(specgit --version --human)" in
  2.*|specgit\ 2.*) ;;
  *) printf '%s\n' 'specgit-bootstrap: SpecGit 2 is required; install it and complete specgit migrate first.' >&2; exit 2 ;;
esac
exec specgit issue "$@"
