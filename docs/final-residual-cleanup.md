# Final Residual Cleanup

Issue #695 reconciles residue against main `74deca06b7779bf90567b841fe36f8e304036b8a`. Dispositions are based on direct Git objects, source comparisons and tests, not branch names or a stale graph index.

## Useful Work

- `codex/oc-path-priority` (`7f5d1aed3e`): retain the installer fix and its three test scripts. The dirty primary `oc` copy is byte-identical to this branch and contains no additional work.
- `feat/unified-predev-acceptance` (`d007da2811`): retain the empty streamed-tool-identity fix and aborted-node cascade regression. Its 15 reasoning subhistory patches are already equivalent to main; its old runtime architecture is superseded and must not be replayed.
- Stash `bc109dbdf3f62367` (original index 2): reconcile verification-scope guidance, current positional SpecGit parser coverage and main-only release guidance. Do not restore its old dev promotion or obsolete version declarations.

## Dirty Drafts

The primary checkout had 18 dirty entries. Seventeen hook, compaction, scenario and generated-client drafts are already shipped by PR #690 or refined by PR #694. Six are byte-identical to main, three documentation drafts match the older PR #690 payload, six are semantic subsets of main, and two differ only in formatting. The remaining installer copy is preserved by the useful branch patch above. None requires retaining an uncommitted draft after delivery.

## Stashes

All 36 stashes were inspected, including untracked third-parent trees where present. Original indexes refer to the pre-cleanup stack, not the current stack after deletion.

- Environment pollution or generated drift: 0, 3, 4, 5, 7, 8, 26, 27, 28, 35. Includes private-registry lockfile churn, package-order changes and SQLite shared-memory cache; no private URLs are reproduced here.
- Already shipped or superseded implementation: 6, 9, 10, 11, 14, 15, 31. Session-local bench fixtures and past repair notes add no current runtime fix and are not retained as delivery residue.
- Obsolete drafts or retired v1 machinery: 1, 12, 13, 16 through 25, 29, 30, 32, 33, 34. Includes stale reasoning status, superseded handoff snapshots and retired SpecGit binding/acceptance assets.
- Useful reconciled content: 2, as described above.

## Historical Issues

- #669: completed by PR #670, merge `6bb00086382653d0c90b32174d98ff7ddd27f821`; stable `graphagent-v1.0.51` was published from that commit.
- #653: the proposed stable 1.0.49 release was superseded by the published 1.0.50 and later stable releases. There is no stable 1.0.49 release; its original version-specific acceptance is not claimed completed.
- #636: retired umbrella whose component work was delivered separately. Its own delivery comment records shipped scope and deferred real-model observations. The two-pass reasoning design and its old holdout criteria were later superseded by the current single-pass design; the unperformed observations are not claimed passed.
- #637: optional synchronous organization was exploration-only, with no implementation authorization. Decline this timing experiment for the maintenance scope: there is no matched evidence demonstrating a quality benefit, while synchronous auxiliary calls add latency and new boundary risks. Preserve the rationale here without creating or claiming a new experiment.

## Final Gates

Deletion follows useful-content delivery and native readback. The final check must show a clean primary checkout on current main, only main in local and origin heads, no extra registered worktrees, an empty stash list, and no open repository Issues or PRs. Protected CI, the official release workflow, tag provenance, published checksums and executable version are verified separately. MCP debugging remains outside this cleanup.
