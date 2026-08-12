# Memory Authority Redo Plan — from `d7b011738`

Date: 2026-08-12. Worktree: `/private/tmp/oc-dag-wt-lifecycle` (branch `chore/worktree-lifecycle-audit`).
Status: ADR-0004 **Rejected**; Occam path (§10) **adopted and implemented** (#1 done; #2 deferred by user; #3/#4 closed as non-gaps). The two-round MEM-PR01 review then landed fixes/pins #5–#18 below. Nothing is left to implement autonomously; remaining items are user decisions (#2 typed-error cascade, source-Home retention/GC).

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

---

## 7. Plan-review findings (ultracode adversarial workflow, 5 critics, 2026-08-12) — REVISES §3–§6

The adversarial review surfaced **blocking issues**. Per the task rule "spec-gap 必须暂停并记录所需产品决策", P1 does NOT start until §7.A is resolved + P0 is approved.

### 7.A. BLOCKING product decisions (need user sign-off — these are NEW surface, not verifiable reconstruction)
The lost ADR-0004 is **unrecoverable** (repo's only ADR-0004 is an unrelated DAG lock-timeout ADR; `git fsck` empty; nothing pushed). "Reconstruct from design memory" is indistinguishable from "invent." The following core decisions are genuinely the user's:

- **D1 — Policy source-of-truth (P1).** Moving Policy into the per-project Home generation as versioned/CAS'd **reverses ADR-0001's live decision** ("Project configuration is resolved from the Project's primary directory so it remains user-editable without creating sandbox-specific policy"). Decide: (a) Policy-in-Home + supersede ADR-0001 (controller-owned, atomic, not user-editable in place), or (b) keep Policy in `.opencode/memory.jsonc` (user-editable, NOT versioned/CAS'd) and P1 collapses to Topics-only atomicity. **Also**: how is GLOBAL Policy represented (it spans projects; no per-project Home)?
- **D2 — Source-Home preserve + retention (P3/P6/P7).** "Source Home preserved, non-authoritative" introduces a NEW class of non-authoritative artifact; ADR-0001/0002 require a "separate Project Memory retention policy" BEFORE any such artifact may exist. Decide: (a) define the retention/GC policy for retired-identity Homes in the recreated ADR-0004, or (b) revert to baseline migrate-then-remove (source deleted) — then the 3 "source Home deleted" assertions stay and P6/P7 preserve-assertions drop.
- **D3 — Retirement-as-merge / alias-lineage (P3).** "Old ID routes to successor" + immutable `recordAlias` tombstone + `canonical()` alias-chain + deterministic-union merge of two Projects' Memory+identity+FK is, in substance, the two **explicitly-forbidden** decisions (Project Merge, ProjectLineageID) relabeled. Decide: (a) approve a lineage/merge system with the exact merge rules + alias permanence, or (b) collapse to migrate-and-retire with conflict-fail-closed (closer to ADR-0001).
- **D4 — New public surface to confirm** (not in any recoverable spec): (i) the 6-phase forward-only journal machine `Requested→TargetPrepared→IdentityPublished→ReferencesRetired→CleanupPending→Completed` (ADR-0002 only states a single ordering invariant); (ii) the opaque Revision fingerprint composition ("canonical identity + Topics revision + Policy fingerprint + topology fingerprint + admission fingerprint" — topology/admission fingerprints are undefined); (iii) the `changeMemory` data-Change algebra (`replace_topics|mark_matched|set_policy`) replacing the baseline callback `updateTopics`.

**⇒ NEW PHASE P0 (mandatory, before P1):** Recreate `packages/opencode/src/memory/docs/adr/0004-project-memory-authority.md` + the CONTEXT authority-glossary update **as a written, committed design-of-record** that resolves D1–D4 explicitly. P0 Green = the user reviews + approves the recreated ADR-0004 line-by-line. No subsequent phase may claim a "faithful" Green until P0 is approved. (This demotes old open-item #4 from optional to blocking precondition.)

### 7.B. Technical revisions (from completeness/phase-ordering/mutation/baseline critics)
- **Reorder: P4 before P3** (or inject `migrateReferences`/`cleanup` as Effect seams in P3, wired in P6). retireLocked's ReferencesRetired→CleanupPending transitions cannot call a ProjectReferenceAdapter that doesn't exist yet.
- **P4 per-table FK migration rules (MEM-REF-07):** `session`,`workspace` → `UPDATE project_id`; `permission` → has `uniqueIndex(project_id,action,resource)` (permission/sql.ts:19) ⇒ DELETE source rows whose `(action,resource)` already exists on successor, then UPDATE the rest (else SQLITE_CONSTRAINT_UNIQUE); `project_directory` → composite `primaryKey(project_id,directory)` ⇒ delete+reinsert preserving `type` (and `strategy`), with a test where successor already has an overlapping directory; `workflow` → `UPDATE project_id`. Add a P4 contract test: a 6th temp `project_id` FK table ⇒ test fails (MEM-REF-07 mutation).
- **P6 file scope:** add `test/project/project.test.ts` (imports `ProjectIdentityMigration` at :30; layer helpers at :87,:101,:119) and `test/memory/memory-persistence.test.ts` to scope, else P6 won't compile (module deleted) / won't be coherent. **P6 flips only `project.test:325`** (the fromDirectory path); the two direct-`migrateHome` assertions (`memory-persistence:166,:194`) are reachable only via `memory/identity-migration.ts` (downgraded in P8) — either leave them asserting `deleted` until P8, or rewrite those two cases to drive `authority.retireIdentity`.
- **Mutation gates (fix mismatches + gaps):**
  - P1 needs TWO: read-side (`revert policy.jsonc co-tenant allow ⇒ strict-read Red`) AND write-side (`publish policy via a separate rename outside the manifest ⇒ crash-injection topics-new/policy-old Red`).
  - P2: relabel to `changeMemory that doesn't bump revision on set_policy ⇒ stale-revision Red`, AND add a **changeMemory-level** crash-injection test (store-API atomicity alone doesn't prove the caller uses it atomically).
  - P6 `orDie` gate only works if the conflict test asserts the error **type** (`Effect.catchTag("RetirementConflict")` / `Cause._tag==="Fail"` + schema `_tag`), NOT `Exit._tag==="Failure"` (baseline project.test:375-377 uses the weak form — copying it = a tautology gate).
  - P3 mutation: `allow phase regression ⇒ monotonic-transition Red; rebind source_id ⇒ same-source-conflict Red`.
  - P7 mutation: `drop sorted() lock order ⇒ reverse-retirement ABBA (both >10s) Red; skip joinRecovery on cold start ⇒ crash-recovery Red`.
  - P6 `split fixture instances` is ambiguous — replace with `fromDirectory resolves MemoryHome/ledger from Global.Path.data instead of the wired Service ⇒ durable-journal-preserved Red`.
- **P8 add Green+Mutation:** `worktree reset/remove with a sibling's new legacy-memory input fails closed via guard (no source Home touched); ambiguous topology ⇒ fail-closed; no-cache rescan observes input added after invalidate. Mutation: re-trust process-local admission cache ⇒ wrong-destroy Red.`
- **inspectHome allow-list** (`identity-migration.ts:43-54`, invoked at :69-70): only accepts `topics/generations/manifest.json`. Once Homes carry `policy.jsonc` (+ ledger paths), any migrateHome MERGE over a modern Home fail-closes with `InvalidHomeError`. P1 must either extend the allow-list or mark inspectHome dead post-P6.
- **Pin ledger locations (global, not per-project):** journal at `home.retirements/<sha(request_id)>.json`, aliases at `home.aliases` (= `<dataRoot>/memory/project-aliases.json`), destructions at `home.destructions/...` — all GLOBAL under `<dataRoot>/memory/`, reachable from any (retired) id. Add a test that a fresh process finds the journal/alias after source Home is non-authoritative.
- **Phase enum canonical = 6 phases** (add `Completed` terminal); reconcile §2 Gap table (5) with §3 (6) — use 6 everywhere. Clarify `CleanupPending` is a retryable-resting state; `Completed` reached only after cleanup (not required this redo since source-Home cleanup is deferred/excluded).
- **Path precision:** AppLayer is at `packages/opencode/src/effect/app-runtime.ts` (alias `@/effect/app-runtime`), `Memory.defaultLayer` at :87 — insert the Authority aggregator's defaultLayer there alongside it.
- **MEM-BOOT-09:** assign to P2 — `authority-live.readMemory` yields a typed `Failure` (ProjectUnavailable) when no durable ProjectV2 row; + test injecting a missing row. (Or cite exact baseline file:line that already fails closed.)

### 7.C. Revised phase order
**P0** (spec, user-approved) → **P1** (identity + atomic store API) → **P2** (authority skeleton + lock + repository; MEM-BOOT-09) → **P4** (reference adapter, all 5 FK) → **P3** (retirement journal + rules + state machine, using P4's adapter or injected seams) → **P5** (dual Layer wiring) → **P6** (fromDirectory cutover = 1C) → **P7** (crash harness = 1A) → **P8** (destruction guard + worktree + remove parallel authorities).

## 8. Resume protocol for a fresh session (read FIRST)
1. `cd /private/tmp/oc-dag-wt-lifecycle` (branch `chore/worktree-lifecycle-audit`). If missing, `git worktree add` it from the branch (it lives in /tmp and may be cleaned — each phase commits, so history is safe).
2. `git log --oneline -8` to see which phases are committed; read this plan doc fully (esp. §7).
3. If **P0 not approved yet**: recreate ADR-0004 + CONTEXT resolving §7.A D1–D4, present to user, **PAUSE**. Do not start P1.
4. Else advance the next un-committed phase (§7.C order). Per phase: re-read exact baseline → implement → `cd packages/opencode && bun typecheck` → targeted tests (package dir only) → mutation gate → `git commit` → update this doc's phase status.
5. Exclusions: no Goal/DAG/DAG-config/CI, no push/PR/dev→main, no source-Home GC. Tests never from repo root.

## 9. Phase status (living tracker)

| Phase | Status | Commit | Notes |
|---|---|---|---|
| P0 — recreate ADR-0004 + CONTEXT | **Proposed (awaiting user approval)** | (this commit) | ADR-0004 + CONTEXT.md written; resolves D1–D4; encodes user principles (shared/no-fork/imperceptible). User must approve before P1. |
| P1 — identity + atomic store API | pending | — | blocked on P0 approval |
| P2 — authority skeleton + lock + repository (MEM-BOOT-09) | pending | — | |
| P4 — reference adapter (all 5 FK) | pending | — | reorder before P3 |
| P3 — retirement journal + rules + state machine | pending | — | uses P4 adapter (or injected seams) |
| P5 — dual Layer wiring | pending | — | effect/app-runtime.ts + server.ts app group |
| P6 — fromDirectory cutover (1C, MEM-ID-AUTO-11) | pending | — | + project.test.ts/memory-persistence.test.ts scope; Spec/Standards review + pause |
| P7 — crash harness (1A, MEM-CRASH-06/LOCK-02) | pending | — | |
| P8 — destruction guard + worktree + remove parallel authorities | pending | — | + Green/mutation per §7.B |

> **§4/§7.C/§9 (the elaborate 8-phase redesign) are SUPERSEDED by §10 below.** Kept for history.

## 10. Occam minimal path (ADOPTED 2026-08-12 — the actual work)

After the survey + ultracode adversarial review, the user applied Occam's Razor ("一切从简"): the elaborate ProjectMemoryAuthority / retirement journal / alias tombstone / opaque Revision / destruction guard / 8-phase plan is over-engineered for the real needs. Confirmed user principles: **one shared Memory per Project (worktrees share it, hold none of their own); Memory never forks; identity upgrade is imperceptible; no data loss.** Shared + no-fork are already satisfied by the baseline d7b011738 (Home follows identity). So the work collapses to small in-place fixes on the existing seams. **ADR-0004 is Rejected.**

| Fix | Gap | Status | Commit |
|---|---|---|---|
| **#1** Repoint `workflow`+`permission` FK on identity upgrade (was `ON DELETE CASCADE` silent data loss) | MEM-REF-07 | ✅ done (mutation-proven) | `ec6972b22` |
| **#2** Remove `.orDie` on the migration seam (`memory/identity-migration.ts` via `project/identity-migration.ts:19`); propagate `ConflictError`/`InvalidHomeError` as typed errors to the instance-store Deferred + HTTP project handler boundary | typed-error invariant (#5) | ⏸ **deferred** — full typed-propagation is a multi-file cascade (seam→migrateProjectId→fromDirectory Interface→instance-store load/reload/Deferred→HTTP) for a marginal gain (HTTP 409 vs 500 on a rare migration conflict; `.orDie` already preserves `ConflictError` in the Die cause, so it stays diagnosable). Awaits user decision: Occam cut vs invariant #5. | — |
| **#3** `migrateHome` deadlock-freedom for opposite-direction migrations | MEM-LOCK-02 | ✅ **fixed (MEM-PR01-R1-24, P2; Red = 20 s deadlock timeout, Green = ms)**: the review falsified the one-way-retirement claim — a changed origin URL yields `previous=remote(A), current=remote(B)` (resolve: `remote ?? previous`), so opposite-direction pairs are reachable. Sorted pre-acquisition is impossible (the flock is non-reentrant; `updateTopics` re-locks the target inside). Fix by construction: a dedicated sorted **pair lock** serializes the two directions, and the merge is restructured into three phases that never hold more than one `memory-project:*` lock at a time (snapshot source → merge via target-locked `updateTopics` → verify-and-remove source; if the source changed meanwhile, fail closed with retryable `SourceChangedError`, nothing removed). Crash-retry convergence pinned by MEM-PR01-R1-13. | this slice |
| **#4** Destructive admission (worktree reset/remove) **force-rescans**, never trusts the process-local admission cache | MEM-ADMIT-03 / RET-04 | ✅ **closed — already handled** | — |
| **#5** Memory is **fail-closed inert under `ProjectV2.ID.global`**: `configuration()` returns undefined while the project has no identity of its own | MEM-PR01-00 (P1, two-round review 2026-08-12) | ✅ done (Red→Green→mutation) | `d6abdf466` |
| **#6** `inspectHome` tolerates the store's own `atomicWrite` residue (`manifest.json.<pid>.<uuid>.tmp`); foreign files still fail closed | MEM-PR01-R1-12 (P2) | ✅ done (Red→Green→mutation) | this slice |
| **#7** Identity-merge conflict check compares **content only** — controller metadata drift (`last_matched_at`/`match_count`/`revision`/`updated_at` from `markMatched`) is not a conflict; real content differences still are | MEM-PR01-R1-15 (P2) | ✅ done (Red→Green→mutation) | this slice |
| **#8** Permission FK repoint is **uniqueness-collision-safe**: on `(project_id, action, resource)` collision the successor row wins and the duplicate old row is dropped; disjoint rows still repoint. The previous bulk UPDATE violated the unique index and wedged the whole upgrade transaction | MEM-PR01-R1-11 (P2) | ✅ done (Red→Green→mutation) | this slice |

**#5 rationale (product decision, Occam route):** every commit-less repository resolves to the SAME shared `global` identity (`core/project.ts` resolve: `id = remote ?? previous ?? root`, and `global` is never cached because `project.ts` skips the identity commit for it). With Home keyed by project ID, an active Memory under `global` would (a) share one Home across all commit-less repositories on the machine (cross-repo topic leakage) and (b) be permanently orphaned at the first commit — identity moves global→root/remote but `migrateProjectId` never migrates away from global (explicit guard; `previous` can never be global). The migration option is structurally infeasible (topics in the shared bucket carry no per-repository provenance), so the minimal correct behavior is **inertness**: memory activates once the repository gains a real identity. One guard at the single activation seam (`Memory.configuration`, which active/prepare/search/checkpoint/setEnabled all funnel through); no new authority, no new machinery. Pre-fix global-bucket contents remain orphans — recovery belongs to the deferred retention/GC decision. Note: this decision constrains the spec — the `lightweight-project-memory` spec has no identity-tier requirement today (review finding MEM-PR01-R1-14); when openspec changes land, add "memory is inert until the project resolves a non-global identity".

**#3 rationale:** `migrateHome` is called only via `migrateProjectId(previous=oldID, current=newID)`; identity retirement is one-way (root→remote), so there is no `migrateHome(B,A)` reverse caller — the two project flocks are never acquired in opposite orders. ABBA is unreachable; no code change warranted.

**#4 rationale:** `worktree/index.ts reconcileLegacyMemory` already runs `memoryAdmission.invalidate(projectID)` **before** `ensure(...)`; invalidation clears the cache entry, so the destructive `ensure` always rescans fresh. The "no stale-cache trust" invariant already holds; no code change warranted.

**Occam path outcome (2026-08-12):** the only *real* gap was **#1** (silent `workflow`+`permission` cascade-loss on identity upgrade) — fixed, tested, mutation-proven, no regressions (project 38, memory-persistence 16, memory 36, worktree 26 — all 0 fail; opencode+core typecheck clean; `git diff --check` 0). #3 and #4 verified as non-gaps; #2 deferred as a cascade awaiting the user's Occam-vs-invariant-#5 call. The driving loop is removed; nothing more to advance autonomously.

**Explicitly cut by Occam** (do NOT build): MEM-ATOMIC-10 (Policy stays in `.opencode/memory.jsonc`; memory is topic content); the authority facade, 6-phase journal, alias tombstone, opaque Revision, destruction guard, crash harness; MEM-CRASH-06 as a forward-journal state machine (POSIX `rename` + the store's generation/manifest atomicity cover content; `migrateHome` can be made idempotent if a crash-retry need is shown).

**Resume protocol (replaces §8 steps 3–4):** ~~do the next pending Fix in order (#2 → #3 → #4)~~ — SUPERSEDED: #1 done, #3/#4 closed (then #3 reopened by the MEM-PR01 review and fixed by construction), #5–#18 done/pinned by the MEM-PR01 slices. There is **no pending autonomous fix**. The only open items are user decisions: #2 (typed-error cascade — approved deferred as MEM-TYPED-02) and source-Home retention/GC. Per-slice discipline (kept for future work): re-read exact baseline → implement → `cd packages/opencode && bun typecheck` AND `cd packages/core && bun typecheck` → targeted test (package dir ONLY) → mutation gate (temp-revert ⇒ a real test flips Red, restore) → `git commit` (conventional) → update this plan. Exclusions unchanged: no Goal/DAG-config/CI, no source-Home GC, no dev→main/release.

### M-C additions (two-round review findings, 2026-08-12)

| Fix | Finding | Status |
|---|---|---|
| **#9** Memory is inert when the identity row is gone: `configuration()` no longer falls back to the stale instance context (`?? ctx.project` removed). A process holding a retired identity can no longer fork a Home under it. | MEM-PR01-R1-03 (P2) | ✅ done (Red→Green→mutation) |
| **#10** Worktree remove/reset reconcile against the **complete** directory snapshot (primary + every registered sandbox), never a single directory: a lone sandbox config can no longer be promoted past disagreeing siblings. | MEM-PR01-R1-06 (P2, blocking) | ✅ done (Red→Green; Red captured on the legacy single-directory behavior) |
| **#11** Migration is gated on `time.initialized` (the memory path's own eligibility rule): uninitialized projects stay inert on worktree remove/reset; residue still fails closed. Existing migration tests stamp initialized accordingly. | MEM-PR01-R1-08 (P3) | ✅ done (Red→Green) |
| **#12** Legacy topic/config files are **re-read and compared immediately before deletion**; content that changed after the scan (older-version writer, hand edit) is preserved and surfaced as a conflict instead of destroyed. Deterministic TOCTOU test holds the store flock to pin the scan→delete window. | MEM-PR01-R1-04 (P2) | ✅ done (Red→Green→mutation) |
| **#13** Admission's explicit-config choice follows `MemoryConfig.load` precedence (memory.jsonc before memory.json); a jsonc/json fork inside the project directory is diagnosed as `config.conflict` instead of silently picking a side, and legacy configs equal only to the non-effective side are no longer deleted as duplicates. | MEM-PR01-R1-10 (P3) | ✅ done (Red→Green→mutation) |
| pin | `/memory on|off` creates/updates the config in the **project worktree** even when the instance context lives in another worktree (sandbox). | MEM-PR01-R1-07 (P2 test-gap) | ✅ pinned |
| pin | Runtime admission snapshot covers **every registered sandbox**: a legacy topic living only in a sandbox is imported on activation. | MEM-PR01-R1-23 (P3 test-gap) | ✅ pinned |

### M-D additions (worktree lifecycle findings, 2026-08-12)

| Fix | Finding | Status |
|---|---|---|
| **#14** `list()` is a pure observation path: no more unconditional `git worktree prune` + deregistration on merely-prunable entries (git also marks inaccessible directories and broken gitdir links prunable while the directory still exists). Prunable entries stay hidden from the listing but otherwise untouched. | MEM-PR01-R1-16 (P2, blocking) | ✅ done (Red→Green→mutation) |
| **#15** Destructive cleanup moved to the action path: `remove()` gains a prunable branch (prune admin data + remove directory if present + branch cleanup + drop registrations) and a git-unknown recovery branch (registered but no git record: reconcile fail-closed, drop the stale registration, never delete the directory). Registration cleanup drops ALL canonically-equal entries (symlinked /var vs /private/var duplicates). | MEM-PR01-R1-18 (P3) + serialization regression | ✅ done (Red→Green→mutation) |
| pin | reset fails closed over invalid legacy memory and preserves it. | MEM-PR01-R1-17 (P2 test-gap) | ✅ pinned (mutation-proven) |
| pin | reset/remove invalidate the admission cache before the rescan (deterministic TOCTOU via reset-primed cache). | MEM-PR01-R1-19 (P2 test-gap, blocking) | ✅ pinned (mutation-proven) |

### M-E additions (store resilience pins, 2026-08-12)

| Fix | Finding | Status |
|---|---|---|
| **#16** Corrupt-manifest fail-closed reads are now Red-tested: an invalid manifest and a manifest referencing a missing generation both fail `readSnapshot`, and `migrateHome` fails closed on the merge path without deleting the unread source Home. Both fail-closed guards proven load-bearing by mutation (fail-open revert → the test Red). | MEM-PR01-R1-02 (P2 test-gap) | ✅ pinned (mutation-proven) |
| pin | `decodeTopic` rejects Topics whose `item_count` disagrees with `items.length`; the store refuses to publish such a generation. | MEM-PR01-R1-20 (P3 test-gap) | ✅ pinned (mutation-proven) |
| pin | An orphaned staging generation (crash mid-`writeSnapshot`, manifest never published) never shadows the committed generation; the store still commits cleanly afterwards. | MEM-PR01-R1-21 (P3 test-gap) | ✅ pinned (mutation-proven) |

### M-F additions (config concurrency findings, 2026-08-12)

| Fix | Finding | Status |
|---|---|---|
| **#17** All writers of a MEMORY config file now serialize on a per-file cross-process flock (`memory-config:<file>`): `writeProject`, `writeGlobal`, and the normalization rewrite in `readConfig`. atomicWrite's byte-atomicity is no longer undermined by whole-document last-writer-wins between `/memory on|off`, admission promotion, and normalization rewrites across worktrees/processes. Pinned by a blocking-observation test (mutation-proven: dropping the lock lets the concurrent writer complete during the hold). Residual (documented, not fixed — Occam): decision-level read-modify-write across processes is not CAS-protected; only the write primitives are serialized. | MEM-PR01-R2-02 (P3, newly-exposed) | ✅ done (Red→Green→mutation) |
| **#18** Cross-process commit protocol now has a real second-process test: a spawned worker commits with a stale expectedRevision and must observe `MemoryStore.CommitConflictError` (ADR-0002's explicit-conflict guarantee), deterministic — unlike the timing-probabilistic updateTopics race test. | MEM-PR01-R2-03 (P3 test-gap) | ✅ pinned |

### M-G additions (documentation alignment, 2026-08-12)

| Item | Finding | Resolution |
|---|---|---|
| **#19** `packages/opencode/src/memory/CONTEXT.md` rewritten to the shipped Occam design: rejected-design glossary/invariants removed (Identity Alias, Canonical Project ID, tombstone retirement, opaque Revision, destruction guard); source Home described as migrate-then-remove (retention deferred); Project Configuration described as the unversioned `.opencode/memory.jsonc` (not Home-versioned); read-leniency split stated (runtime read projects empty; strict reads/migration fail closed); ADR-0001 policy clause restored as live; ADR-0004 marked Rejected; M-A…M-F behaviors reflected (global inertness, content-only conflicts, non-destructive list, fail-closed reset/remove, per-file config lock). | MEM-PR01-R1-01 (P3, blocking) | ✅ done |
| **#20** Redo-plan internal consistency: header status no longer says PLANNING; the §10 resume protocol is marked superseded (no pending autonomous fix; only user decisions remain). | MEM-PR01-R1-25 (P3) | ✅ done |
| **#21 (decision)** Git-exclusion narrowing is intentional and documented here: `ensureProjectExclude` installs only the two config candidates, not `.opencode/memory/`. Legacy topic files preserved fail-closed (topic.invalid/topic.conflict) are therefore visible in `git status` and committable. Trade-off accepted: surfacing repair-pending files beats silently git-excluding user data; the delta spec drops the old scenario and the test pins the narrowed behavior. | MEM-PR01-R1-09 (P3 spec-gap) | ✅ decision recorded |
| **#22 (requirement)** Identity-upgrade requirement recorded (the openspec workspace is untracked, so this plan carries it): **Identity upgrade preserves Project Memory and Project-owned references.** Scenarios: (a) root→first-remote migrates the Memory Home before the old Project row is deleted and repoints session/workspace/workflow/permission references; (b) a successor permission colliding on (project_id,action,resource) wins without wedging; (c) merge (not fork) when the successor already has Memory, content-conflicts fail closed; (d) crash mid-migration retries to convergence; (e) global identity is inert. Pinned by the M-A/M-B/M-C/M-E tests. | MEM-PR01-R1-14 (P3 spec-gap) | ✅ requirement recorded |
