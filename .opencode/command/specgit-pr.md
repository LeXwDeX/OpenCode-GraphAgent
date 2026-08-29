---
description: Repair the SpecGit PR binding — auto-discover by head branch or bind explicitly
---

<!-- specgit-managed-entry-point -->

# /specgit-pr

Thin trigger for PR-binding repair. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Run from the delivery branch:

   ```bash
   specgit pr --json
   ```

2. Branch on the result:
   - `exit 0` → the record's PR binding is repaired; resume the delivery.
   - `pr_not_found` → push the branch (re-running `specgit issue`
     resumes the bootstrap), then rerun this command.
   - `pr_ambiguous` → several open PRs share the head branch; bind one
     explicitly: `specgit pr <number>`.
3. `specgit pr` owns the PR binding; never hand-edit `.specgit.yaml`.
   `--json` is the only parse surface.
