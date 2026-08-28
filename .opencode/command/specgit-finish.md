---
description: Run the SpecGit evidence verdict and drive the fix loop to exit 0
---

<!-- specgit-managed-entry-point -->

# /specgit-finish

Thin trigger for the acceptance verdict. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Run from the delivery branch:

   ```bash
   specgit finish --json
   ```

2. Branch on the exit code:
   - `exit 0` → produce the merge brief (issues + PR + CI run links + the
     verdict) and ask the user to approve the merge. Do not merge yourself
     without approval.
   - `exit 1` → read `errors[].fix` / gate failures, fix exactly what they
     name, re-run. Loop until exit 0.
   - `exit 3` → report the environment problem (gh auth / network); never
     edit the record or the policy to work around it.
3. Iron rules: never weaken `spec_git/policy.yaml` to pass; `--json` is the
   only parse surface; a non-zero verdict never merges.
