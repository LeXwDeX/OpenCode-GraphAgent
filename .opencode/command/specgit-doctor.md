---
description: Diagnose the SpecGit environment probes and drive the exit-3 repair loop
---

<!-- specgit-managed-entry-point -->

# /specgit-doctor

Thin trigger for the exit-3 diagnostic loop. The canonical behavior lives in
the AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Run from the repo root:

   ```bash
   specgit doctor --json
   ```

2. Read `probes[]`: every failing probe carries a `code` (git, repo,
   origin, gh/glab presence and auth, policy).
3. Fix exactly what the failing probe names, then re-run
   `specgit doctor --json` until exit 0.
4. Return to the verdict: `specgit finish --json`. Exit 3 is environment,
   never delivery — do not edit the record or the policy to work around it.
5. `--json` is the only parse surface.
