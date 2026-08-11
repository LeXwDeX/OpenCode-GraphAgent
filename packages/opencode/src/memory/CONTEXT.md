# Project Memory Context

Project Memory preserves user-confirmed, durable human context for one Project. It is not a code index, task tracker, instruction source, or general model-writable store.

## Glossary

| Term | Meaning |
| --- | --- |
| Project Memory | The authoritative durable Topic set owned by one Project identity and shared by all of that Project's worktrees. |
| Memory Home | The Project-scoped persistence boundary for Project Memory. Its identity follows the Project, not a checkout path. |
| Topic | A bounded structured collection of confirmed preferences, decisions, or terms with controller-owned metadata. |
| Legacy Worktree Memory | Memory files stored inside a checkout by an older runtime. They are migration inputs, never a second authoritative store. |
| Memory Conflict | A case where legacy and Project Memory claim the same logical identity with different valid content, or where legacy configuration differs from the Project configuration. |
| Project Configuration | The user-editable MEMORY policy owned by the Project and shared by its worktrees. |
| Memory Admission | The single legacy input seam that scans one Project snapshot, reconciles it once, and caches only conflict-free results. |

## Invariants

- One Project identity has one authoritative Project Memory.
- Two worktrees of the same Project cannot form independent Memory namespaces.
- Current user input and higher-priority instructions always override retrieved Memory.
- The controller owns persistence, metadata, migration, limits, and atomicity; models only propose bounded semantic actions.
- Migration writes a durable authoritative copy before removing a legacy copy.
- A Memory Conflict is explicit and fail-closed; no component silently chooses or overwrites conflicting durable context.
- Removing or resetting a worktree cannot imply deleting Project Memory.
- Removing Project Memory requires a separate Project retention decision.
- Runtime reads never perform ad-hoc legacy migration; they consume a Project snapshot admitted by `MemoryAdmission.ensure`.

## Boundaries

- Project identity and registered worktrees come from the Project context.
- Worktree lifecycle invalidates and reruns Memory admission before destructive operations, but it does not own Project Memory retention.
- Session runtime may retrieve and attach bounded Memory context, but it does not own Topic persistence.
- Codebase discovery belongs to codebase-memory facilities and is rejected from Project Memory.

## Decisions

- [ADR-0001: Project identity owns Memory](docs/adr/0001-project-owned-memory.md)
- [ADR-0002: Project Memory commits are versioned and process-safe](docs/adr/0002-project-memory-commit-protocol.md)
- [ADR-0003: Legacy Memory enters through Project admission](docs/adr/0003-memory-admission.md)
