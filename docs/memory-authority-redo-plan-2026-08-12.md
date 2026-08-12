# Memory Authority Redo Plan — from `d7b011738`

Date: 2026-08-12. Worktree: `/private/tmp/oc-dag-wt-lifecycle` (branch `chore/worktree-lifecycle-audit`).
Status: PLANNING (awaiting user confirmation before any implementation/loop).

## 0. Why this plan exists

The prior ProjectMemoryAuthority redesign (~20 untracked files: `authority-*.ts`, `destruction-guard.ts`, `project/identity.ts`, `project/reference-adapter.ts`, ADR-0004, CONTEXT update, ~4 authority test files, crash-harness fixtures) plus the 1A keystone/harness fixes lived **only as uncommitted working-tree state** in a `/private/tmp` worktree. `/private/tmp` was cleaned; `git fsck` found no dangling objects and the branch was never pushed, so that work is **gone**. Recoverable: the committed baseline `d7b011738` ("fix(opencode): make project memory process safe") — the Iteration-1 process-safe memory foundation. This plan reconstructs the lost redesign **faithfully** (from the approved ADR-0004 / CONTEXT / redesign-decision spec, retained in design memory) on top of that baseline, phased so each stage is independently committable.

## 1. Baseline at `d7b011738` (surveyed — what exists, all tests GREEN)

**Modules** (`packages/opencode/src/memory/`):
- `home.ts` MemoryHome — paths only: `directory/topics/manifest/generations` + shared `locks` dir. No policy/retirements/aliases paths yet.
- `store.ts` MemoryStore — generation+manifest persistence. **Topics are versioned** (revision int, named generation, atomic temp→rename→manifest). **Policy is NOT in the Home** — it lives in worktree/global `.opencode/memory.jsonc|json` via MemoryConfig, no generation/revision/CAS. `commit(expectedRevision)` CAS exists but is **unused in src/**; `updateTopics` (hides revision bump) is the live writer. Strict `inspectTopics` vs lenient `readTopics`.
- `lock.ts` MemoryLock — **in-process `KeyedMutex` only**, surface is just `withProject(projectID)`. NO canonical/Held/FenceClosed. (Controller-only; 4 sites in `memory.ts`.)
- `admission.ts` MemoryAdmission — the legacy-input seam: `ensure`/`invalidate`, caches only conflict-free results, nests `memory-admission:` → `memory-project:` flock.
- `identity-migration.ts` MemoryIdentityMigration — **only `migrateHome(oldID,newID)`** (no prepareHome/migrateIdentity). Fast-path `fs.rename(source,target)`; merge-path merge-then-`fs.remove(source)`. **Both DELETE source.** Typed `ConflictError`/`InvalidHomeError` exist.
- `config.ts` MemoryConfig, `paths.ts`, `file.ts` (atomicWrite), `schema.ts`, `model.ts`, `prompts.ts`.

**Two lock systems (non-overlapping):** MemoryLock (in-process KeyedMutex) vs `EffectFlock` (`core/util/effect-flock.ts`, cross-process mkdir-dir locks, `STALE_MS=60s`, heartbeat ~20s, breaker stale-takeover, witness = Scope lifetime).

**Project identity upgrade** (`project/project.ts:217-314` `fromDirectory`; `migrateProjectId` `:148-197`): resolve → `identityMigration.migrate(old,new)` (FIRST durable; **`.orDie` collapses typed errors to defects**) → DB txn (copy Project row; `delete ProjectDirectory`; repoint `Session`+`Workspace` FK; `delete ProjectTable old`) → upsert new Project row → Session global→new → saveProjectDirectory → `emitUpdated` (in-memory) → `projectV2.commit` (writes `<commonDir>/opencode` cache, LAST durable).

**5 Project-owned FK tables** (`ON DELETE CASCADE`): `session`✅repointed, `workspace`✅repointed, `project_directory`(deleted+reinserted), `workflow`❌**cascade-lost**, `permission`❌**cascade-lost**. ⇒ every root→remote upgrade today silently destroys all DAG workflows + saved permissions.

**Worktree** reset/remove call only `memoryAdmission.invalidate`→`ensure` (gated by serviceOption), pure-FS `hasUnresolvedLegacyMemory` fallback; errors stringified into `Remove/ResetFailedError`.

**3 tests encode "source Home deleted"** (`memory-persistence:166,194`; `project.test:325`) — backed by the single `fs.remove(source)` at `identity-migration.ts` tail. 4 tests encode "preserve on failure" (must stay green). `MemoryLock.withProject` is untested.

## 2. The gap (what the redo must build) — Gap IDs

| Gap | Baseline failure | Redo delivers |
|---|---|---|
| `MEM-ID-01` | ID change migrates Memory + only 3/5 FK; old ID can re-fork; source Home destroyed | One `retireIdentity` migrates Memory + **all 5** FK atomically; source Home **preserved** (non-authoritative); old ID routes to successor |
| `MEM-LOCK-02` | In-process lock only; migration `old→new` flock nesting not proven vs reverse; no canonical recheck | Cross-process sorted flock order (no ABBA); routine = one canonical project flock + recheck |
| `MEM-CRASH-06` | Migration crash (rename/remove mid-flight) unrecovered; no journal | Forward-only journal `Requested→TargetPrepared→IdentityPublished→ReferencesRetired→CleanupPending`; crash = forward recovery from durable evidence |
| `MEM-REF-07` | `workflow`+`permission` cascade-lost | `ProjectReferenceAdapter` migrates **all** FK in one immediate txn; new FK ⇒ contract test fails |
| `MEM-BOOT-09` | (mostly closed) Memory admission needs durable Project row | fail-closed `ProjectUnavailable` when no durable row |
| `MEM-ATOMIC-10` | Topics versioned, Policy not — half-commit window | Topics+Policy share **one generation + one manifest + one opaque revision** |
| `MEM-ID-AUTO-11` (1C) | `fromDirectory` uses legacy `.orDie` migrateHome bypass | `fromDirectory` → `authority.retireIdentity`, typed errors, retirement before successor upsert/cache commit/return |
| `MEM-ADMIT-03`/`RET-04` | Worktree reset/remove trusts process-local admission cache | `ProjectMemoryDestructionGuard` sealed intent; no-cache rescan of primary+all worktrees |

## 3. Reconstructed design (the authority spec — faithful to ADR-0004)

**Public seam** (application callers see ONLY this):
```ts
interface ProjectMemoryAuthority {
  readMemory(projectID): Effect<Snapshot, Failure|AdmissionConflict>
  changeMemory(revision, changes: NonEmpty<Change>): Effect<Snapshot, Failure|AdmissionConflict|RevisionConflict>
  retireIdentity(request: IdentityRetirement): Effect<RetirementReceipt, Failure|AdmissionConflict|RetirementConflict>
}
```
- `Revision` opaque, one-shot, caller-unforgeable, binds canonical identity + Topics revision + Policy fingerprint + topology + admission fingerprint.
- `readMemory` performs runtime admission internally (no `admit→read` composition).
- `changeMemory` accepts data `Change`s (`replace_topics|mark_matched|set_policy`), not Effect callbacks.
- `retireIdentity` is the **only** identity-migration entry.

**Atomic Topics+Policy**: extend `MemoryStore` with `readAuthoritySnapshotInFence`/`commitAuthorityInFence`/`writeAuthoritySnapshotInFence` — `writeSnapshot` writes `policy.jsonc` **into the same generation dir** as topic YAML; manifest rename is the single publish point; strict topic read tolerates the co-tenant `policy.jsonc`.

**ProjectIdentity** (`project/identity.ts`): `canonical(id)` (resolve alias chain, cycle→error), `revision`, `recordAlias(old,new)` (immutable tombstone, rejects retarget/retired-successor/cycle). Alias file is a DB-external durable ledger.

**IdentityLedgerAdapter** (`authority-journal.ts` + `authority-journal-store.ts`): journal keyed by `request_id`, unique `source_id` per in-flight; `save` rejects rebind + regression; phase enum `Requested→TargetPrepared→IdentityPublished→ReferencesRetired→CleanupPending→Completed`.

**Retirement merge rules** (`authority-retirement-rules.ts`): empty/empty→empty gen; non-empty/empty→copy source; empty/non-empty→keep successor; both→deterministic union (Topics by id, Policy unique, `revision=max+1`); same-id-differing-content / Policy-differ / corrupt → `RetirementBlocked` zero-change.

**ProjectMemoryAuthorityLock** (`authority-lock.ts`): wraps EffectFlock. `canonical(id,use)`: resolve→lock one `memory-project:<canonical>`→recheck→retry-on-change. `retirement(source,successor,use)`: `sorted({source,successor})` project flocks. No dynamic extension; rolling-upgrade-compatible key order.

**ProjectReferenceAdapter** (`project/reference-adapter.ts`): dynamically enumerate all `project_id` FK tables; migrate source→successor in ONE `immediate` txn; contract test fails if a new FK table appears.

**ProjectMemoryDestructionGuard** (`destruction-guard.ts`): sealed durable intent `{request_id,requested_project,identity_revision,normalized_target,action,topology_fingerprint,candidate_fingerprint}`; execute/reconcile always join/recover retirement → re-resolve → no-cache rescan primary+all worktrees → publish valid candidates → one fixed action adapter; ambiguous postcondition = fail-closed.

**Lock order**: retirement reads ledger unlocked → `sorted(source,successor)` project flocks → identity-ledger flock → revalidate. Routine: join/recover touched retirement → resolve → one project flock → resolve → retry. (Recovery before routine project lock; routine never project→ledger.)

**Crash semantics**: commit point = immutable tombstone. Pre-tombstone: source authoritative. Post-tombstone: successor authoritative, old revision invalid. Each public command first joins/recovers touched journals. Source Home preserved; cleanup is retryable, `CleanupPending` allowed.

**Layer wiring (BOTH systems)**: `defaultLayer` self-provides all sub-services (mirror `memory/memory.ts:581-603`); `.node` re-lists them; register in `app-runtime.ts` AppLayer **and** `server/routes/instance/httpapi/server.ts:210-287` app group (else HTTP path silently no-ops).

## 4. Phased redo — each phase is one commit on the branch

Order is dependency-driven; each phase has a Green proof + a mutation gate.

- **P1 — Foundation: ProjectIdentity + atomic Topics+Policy store API.**
  Files: `project/identity.ts`; extend `memory/store.ts` (authority snapshot read/commit/write, `policy.jsonc` co-tenant strict-read), `memory/home.ts` (add `policy`/`retirements`/`aliases` paths).
  Green: new unit tests for identity canonical/alias + atomic Topics+Policy commit/read (crash-injection Red: no topics-new/policy-old). Mutation: revert `policy.jsonc` co-tenant allow ⇒ provenance Red.

- **P2 — Authority skeleton + Lock + Repository.**
  Files: `memory/authority.ts` (seam + typed errors + Revision), `authority-lock.ts`, `authority-repository.ts` (inspect/inspectIfDurable/inspectHome via authority store API), `authority-live.ts` (readMemory/changeMemory).
  Green: repository+lock unit tests; CAS revision invalidation on Topics/Policy change. Mutation: changeMemory without atomic commit ⇒ half-commit Red.

- **P3 — Retirement journal + rules + process (state machine).**
  Files: `authority-journal.ts`, `authority-journal-store.ts`, `authority-retirement-rules.ts`, `authority-retirement.ts` (retireLocked: observe→prepare→publish→references→cleanup).
  Green: monotonic phase transition; merge-rule table; idempotent same-request; same-source→other-successor = conflict; reverse/retarget/independent-project rejected zero-change.

- **P4 — Reference adapter (all 5 FK).**
  Files: `project/reference-adapter.ts`.
  Green: migrate all 5 FK in one txn; source=0/target-no-dup post-migrate; **add a 6th temp FK in a test ⇒ contract test fails** (MEM-REF-07 mutation).

- **P5 — Wire authority into both Layer systems.**
  Files: `authority-live.ts` aggregator defaultLayer+node; `app-runtime.ts`; `server.ts` app group; add `.node` to consumers that need it.
  Green: integration test that authority reaches the HTTP path (not just that layers build). Mutation: drop from server app group ⇒ HTTP no-op Red.

- **P6 — `Project.fromDirectory` cutover + typed-error boundaries (this is "1C", `MEM-ID-AUTO-11`).**
  Files: `project/project.ts` (replace `migrateProjectId`→`authority.retireIdentity`, retirement BEFORE successor upsert + cache commit + return; stable internal request identity); delete legacy `project/identity-migration.ts` application seam; `project/instance-store.ts` (thread retirement typed errors through Deferred); `server/routes/instance/httpapi/handlers/project.ts` (map `Failure|AdmissionConflict|RetirementConflict` at HTTP boundary); flip the 3 "source Home deleted" assertions → preserved.
  Green: real `fromDirectory` root→remote produces durable journal ≥ CleanupPending; cache not switched before authority success; metadata conflict ⇒ stable typed error, zero side-write; retry = same request identity monotonic; defaultLayer + LayerNode both use authority; source Home exists but non-authoritative. Mutation gates (5): drop the call / move cache-commit early / randomize request identity / `orDie` the typed error / split fixture instances.

- **P7 — Crash harness + forward-recovery + reverse-retirement (this is "1A", `MEM-CRASH-06`/`MEM-LOCK-02`).**
  Files: `test/fixture/project-memory-authority-{launcher,worker,bunfig}.ts`, `test/memory/project-memory-authority.test.ts`, `memory-authority-journal/rules.test.ts`.
  Green: harness contract (launcher-ready→go→worker-ready→phase-stopped→SIGKILL, file-per-state, self-stop inside worker, reclaim stale 60s flock after kill); per-phase crash→new-process recovery; reverse retirement no-ABBA (both exit ≤10s, exactly one success/one structured failure, full stdout/stderr captured).

- **P8 — Destruction guard + worktree migration + remove parallel authorities (1B/1D scope).**
  Files: `memory/destruction-guard.ts`; `worktree/index.ts` reset/remove → guard (drop direct `MemoryAdmission.ensure/invalidate`); downgrade `MemoryLock` public Service + `MemoryAdmission`/`MemoryIdentityMigration` to internal adapters; final `rg` bypass audit + call graph.

## 5. Verification & discipline (every phase)
- From package dir only: `cd packages/opencode && bun test …`; `bun typecheck`; `packages/core && bun typecheck`; repo-root `git diff --check`.
- Real SQLite, real tmpdirs, real git worktrees, real subprocesses; no fixed-sleep timing; no deleted assertions / no `.skip`/`.todo` to go green.
- Each phase = one conventional commit (`feat(memory): …`) on the branch (mitigates /tmp loss).
- Introduced P1/P2 per phase must close before the phase commits.

## 6. Open items for the user (decide before loop)
1. Confirm the 8-phase structure + that P6 = "1C" and P7 = "1A" (the original iteration labels).
2. Loop cadence/scope: drive P1→P8 in order (one phase per fire), commit each, pause after P6 (1C) for review as the original 1C task required — or different?
3. The 3 "source Home deleted" assertion flips (P6) and the source-preserve semantics are a product decision restated in ADR-0004 — confirm acceptable to re-apply.
4. Should P1 also recreate ADR-0004 + the CONTEXT authority-glossary update (lost) as the design-of-record before code?
