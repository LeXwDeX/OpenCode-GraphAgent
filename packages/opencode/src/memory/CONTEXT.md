# Project Memory Context

Project Memory preserves user-confirmed, durable human context for one Project. It is not a code index, task tracker, instruction source, or general model-writable store.

## User principles (confirmed 2026-08-12)

- **One shared Memory per Project.** Worktrees hold no Memory of their own; they all share the Project's single Memory.
- **Memory never forks.** Memory is core, topic-typed content; worktrees (small PRs) must not branch it into per-worktree copies.
- **An identity upgrade is imperceptible.** When a repo gains its first remote (root → first-remote identity), the user's Memory endures seamlessly — nothing the user notices is lost, moved, or forked.

## Glossary

| Term | Meaning |
| --- | --- |
| Project Memory | The authoritative durable Topic set owned by one Project identity and shared by all of that Project's worktrees. |
| Memory Home | The Project-scoped persistence boundary for Project Memory. Its identity follows the Project, not a checkout path. |
| Topic | A bounded structured collection of confirmed preferences, decisions, or terms with controller-owned metadata. |
| Legacy Worktree Memory | Memory files stored inside a checkout by an older runtime. They are migration inputs, never a second authoritative store. |
| Memory Conflict | A case where legacy and Project Memory claim the same logical identity with different valid content, or where legacy configuration differs from the Project configuration. |
| Project Configuration | The MEMORY policy owned by the Project and shared by its worktrees. Under ADR-0004 it lives in the Memory Home, atomically versioned with Topics; worktree/global config files are admission candidates only. |
| Memory Admission | The single legacy input seam that scans one Project snapshot, reconciles it once, and caches only conflict-free results. |
| Identity Alias | A durable old→new Project identity tombstone owned by `ProjectIdentity`. Every Memory read and mutation resolves it before choosing a Home or lock. |
| Requested Project ID | A Project ID held by a caller. It may already be retired and therefore is not an ownership key. |
| Canonical Project ID | The current terminal Project ID that owns Project Memory. Resolved inside the Project Memory authority and not supplied by callers. |
| Identity Retirement | A forward-only replacement of one Project ID by its successor while preserving one logical Project and all Project-owned state — merge into one Memory, not a fork. |
| Project Merge | A product operation that combines two independently owned Projects. Identity Retirement never performs an implicit Project Merge. |
| Project Memory Revision | An opaque version of one Project Memory snapshot, including Topics, Project Configuration, topology, and admission inputs. |

## Invariants

- One Project identity has one authoritative Project Memory.
- Two worktrees of the same Project cannot form independent Memory namespaces; Memory never forks per worktree.
- Current user input and higher-priority instructions always override retrieved Memory.
- The controller owns persistence, metadata, migration, limits, and atomicity; models only propose bounded semantic actions.
- Migration writes a durable authoritative copy before treating a legacy copy as consumed.
- A Memory Conflict is explicit and fail-closed; no component silently chooses or overwrites conflicting durable context.
- Removing or resetting a worktree cannot imply deleting Project Memory.
- Removing Project Memory requires a separate Project retention decision.
- Runtime reads never perform ad-hoc legacy migration; they consume a Project snapshot admitted by the Project Memory authority.
- Project identity retirement validates the full transition before durable state changes, prepares the successor while preserving the source, publishes one identity commit point (the tombstone), and completes Project-owned reference migration by forward recovery.
- Routine Project Memory commands resolve identity, acquire one canonical Project commit right, and recheck identity before reading or writing.
- A missing Memory Home is empty; an existing corrupt Home is an error and is never projected as an empty Topic set.
- Project configuration and Topic mutations publish under one generation, one manifest, and one opaque Revision, in the same cross-process Project lock.
- Application callers never receive canonical IDs, Home paths, locks, cache keys, or migration callbacks.
- A revision issued before Identity Retirement cannot commit after the identity commit point.
- Destructive Memory Admission always observes current candidate files; it never trusts a process-local success cache.
- The retired source Home is preserved as a non-authoritative backup; its GC is a separate, deferred decision.

## Boundaries

- The Project Memory authority obtains identity, the primary checkout, and every registered worktree from durable Project state; callers provide only a requested Project ID.
- Worktree lifecycle requests destructive admission as one command through the internal destruction guard; it does not invalidate caches, assemble snapshots, or own Project Memory retention.
- Session runtime may retrieve and attach bounded Memory context, but it does not own Topic persistence.
- Codebase discovery belongs to codebase-memory facilities and is rejected from Project Memory.

## Decisions

- [ADR-0001: Project identity owns Memory](docs/adr/0001-project-owned-memory.md) *(Policy-source clause superseded by ADR-0004)*
- [ADR-0002: Project Memory commits are versioned and process-safe](docs/adr/0002-project-memory-commit-protocol.md)
- [ADR-0003: Legacy Memory enters through Project admission](docs/adr/0003-memory-admission.md)
- [ADR-0004: Project Memory authority owns identity and commits](docs/adr/0004-project-memory-authority.md) — **Proposed (P0, awaiting approval)**
