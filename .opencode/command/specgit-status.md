---
description: Show local SpecGit evidence — record, delivery state, drift, origin
---

<!-- specgit-managed-entry-point -->

# /specgit-status

Thin trigger for local evidence. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Run from the repo root:

   ```bash
   specgit status --json
   ```

2. Read `state` and `record` from the envelope: local evidence only —
   record, drift, origin. Platform evidence (issues, PR, checks) belongs
   to `specgit finish`.
3. No record is not an error: `state: "unbound"` with exit `0` is the
   normal pre-binding state — bootstrap with `specgit issue` (the
   `record_missing` warning carries the next step in `warnings[].fix`).
   Exit `3` is different: `state: "unknown"`, a genuine evidence
   failure — read `errors[].fix`.
4. Never hand-edit `.specgit.yaml`.
