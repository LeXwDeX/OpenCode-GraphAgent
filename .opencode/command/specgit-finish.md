---
description: Run the SpecGit evidence verdict and drive the fix loop to exit 0
---

<!-- specgit-managed-entry-point -->

# /specgit-finish

Thin trigger for the acceptance verdict. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Complete the authorized PR body and mark the PR ready for review, then
   run from the delivery branch:

   ```bash
   specgit finish --json
   ```

2. Branch on the exit code:
   - `exit 0` → report issues, PR, CI run links, and the verdict; continue
     the authorized merge through the guidance below.
   - `exit 1` → read `errors[].fix` / gate failures, fix exactly what they
     name, re-run. Loop until exit 0.
   - `exit 3` → run `specgit doctor --json`, repair the named evidence
     failure within your permissions, and retry the verdict.
3. Iron rules: never weaken `spec_git/policy.yaml` to pass; `--json` is the
   only parse surface; a non-zero verdict never merges.

Continue within existing user authorization. With automation enabled, the
trusted remote completion workflow continues after CI without another user
confirmation. `specgit pr --merge --json` is its recovery path. It requires
the approved target policy, `finish` exit 0, and all CI checks passing at the
current PR head. Completion means the merge and every bound issue closure are
confirmed; a partial closure remains recoverable. `finish` is read-only and
exit 0 means accepted, not necessarily completed. A failed delivery is tracked
by a repair issue; retries reuse that cause and preserve the original PR.
Automation defaults to no. Only the user's own yes enables it through
`specgit init --automation yes --merge-target <branch>`; ordinary `init --force`
preserves that choice and target. An agent must not choose yes for the user. When an
action lacks user authorization or platform permission, report the specific
missing permission with the prepared result.
