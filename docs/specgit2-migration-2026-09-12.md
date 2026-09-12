# SpecGit 2 migration evidence — 2026-09-12

The repository uses the shared SpecGit 2 declaration and native GitHub Issue/PR observation. Normal project commands use the installed SpecGit 2.0.0 CLI. Repository auto-merge and supplementary automatic issue closure remain disabled.

## Native cutover

- Repository: `LeXwDeX/OpenCode-GraphAgent`; default/integration branch `dev`, stable releases from `main`.
- [Issue #586](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues/586) tracks the migration. [PR #587](https://github.com/LeXwDeX/OpenCode-GraphAgent/pull/587) retired the generated v1 acceptance workflow, commands and merge guard. Its exact head `7346f0dfb4e1b0a92400840fe47c91a888a2aee7` passed Typecheck, Linux unit tests, Linux/Windows E2E and CodeQL, and merged as `32a80bb6b2a08f1a23b55dcc7d73b27f9a9d4067`.
- Both `dev` and `main` require native `Typecheck` and `Unit Tests (linux)`. Main's retired `SpecGit Acceptance` check was removed only after those equivalent checks were active and verified. The old workflow ID `337465333` is natively `deleted`. Product CI and release checks remain enabled.
- The official `migrate --retire-only` transaction first retired owned local v1 assets while preserving the declaration and restorable backup. Historical policy/drafts remain archival inputs; they do not replace native required checks.

## Explicit native retirement exception

GitHub run `32210748139` remains queued for old head `e3877c0c955c1aa60cb689931a3cbb99d30d1fb9`, from 2026-08-19. Its original PR #356 is already merged. Native cancel and force-cancel returned 409; user-authorized deletion returned 403. The user explicitly approved a migration exception for this one run. It was not reported as deleted, cancelled or completed.

The migration check binds the exact repository, CodeQL workflow `260521487`, check suite `87318529941`, head, first attempt, timestamps and three job IDs. Every preview/apply re-reads the native run, workflow and complete job inventory. Jobs must remain queued with no runner, completed time or steps. The API's non-null job `started_at` values are preserved without inferring that execution never began. Other unfinished runs and old writers still block activation.

## Tool boundary

Installed SpecGit 2.0.0 incorrectly rejects GitHub-managed dynamic workflow paths during migration inventory. An isolated, reviewed build from SpecGit source `d059d8f2d2366f7254c0e1b0950cb8cdcd32a4d6` added exact recognition for five observed github.com managed paths and the explicit single-run exception. Unknown paths, identity/state drift and incomplete native evidence remain fail-closed. All observations and the exception participate in the preview digest and restorable migration backup.

The isolated binary is not an official published artifact and did not replace the global installation. Its SHA256 is `0172c11df71fbf101d4ee73128afececfda6e6eceaf0fd172f7a63f9b92e03b4`. The 27 migration tests, Rust formatting and release build passed. This fix is used only for the one-time cutover; ordinary SpecGit 2 project operations do not depend on it.

## Activation readback

Activation completed with `status=migrated`, transaction `tx-RD7DiA`, preview digest `eaf3bd57683ac2c711080cc487aec90ce2fb90aabd1e338ad8ab55cd2e6f52f5`, and `activation=v2_activated_with_explicit_retirement_exception`. The final native inventory contained no writer blockers and only the explicitly excepted queued run. The normal post-merge run [34686583212](https://github.com/LeXwDeX/OpenCode-GraphAgent/actions/runs/34686583212) had completed successfully before activation.

The ordinary installed `specgit 2.0.0 init --check --json` returned `status=inspected`, exit 0 and no diagnostics after migration. The declaration is version 2, target `dev`, with both automation preferences false. The local transaction retains the exact backup and native observations under the repository git directory. Product PR checks, final Issue closure and stable publication are verified separately by the release delivery.
