# Workflow Orchestration Context

Workflow Orchestration turns one user objective into one durable DAG. It supports saved or inline custom workflows and recommends heuristic composition from reusable Blocks. Low-level Nodes remain available when a Block route cannot express the objective.

## Glossary

| Term | Meaning |
| --- | --- |
| Workflow Source | An inline object or YAML document supplied to start, extend, replan, read, validate, or release tooling. |
| Workflow Authoring Check | The side-effect-free source-to-graph boundary that parses, normalizes file compatibility, decodes the action shape, compiles Blocks, applies the selected validation profile, and returns diagnostics or a Prepared Workflow Graph. |
| Prepared Workflow Graph | A strictly decoded and compiled graph that passed the requested authoring checks and is ready for a runtime mutation. |
| Workflow Route | A complete Block or Node composition selected for one objective. It may be custom, saved, or assembled heuristically. |
| Orchestration Router | The product-owned parent guidance that qualifies an objective and selects one Workflow Route without external Skill discovery. |
| Block Composer | The Orchestration Router decision that selects the smallest Block graph justified by current evidence. |
| Decision Checkpoint | One parent-owned confirmation for unresolved user choices that materially change behavior, scope, acceptance, or an irreversible boundary. |
| Workflow Brief | The recommended route, scope, acceptance evidence, assumptions, risks, and material alternatives presented at a Decision Checkpoint. |
| Block | A reusable high-level orchestration capability such as explore, plan, debug, coding, verify, or review. Blocks compile into Nodes. |
| Node | A low-level durable unit of child-agent work with dependencies, prompt input, policy, and output contract. |
| Validation Profile | `portable` checks source-contained structure without user environment state; `environment` additionally resolves live agents, prompt assets, and models. |
| Runtime Admission | The READY/WAIVED gate for a deep workflow. It is a lifecycle policy after authoring, not another name for Workflow Authoring Check. |

## Invariants

- One user objective has at most one live DAG; route expansion stays inside that DAG.
- Block composition is the recommended authoring path and is selected heuristically from the objective; custom Blocks/Nodes remain supported.
- Workflow Authoring Check is the only raw source-to-Prepared Workflow Graph authority used by tool actions, CLI, generation, and packaging.
- Parsing, file-only compatibility, strict action decoding, Block compilation, and profile diagnostics are not reimplemented by callers.
- `portable` validation does not load user environment catalogs. `environment` validation reads current catalogs and verifies actual model availability.
- No workflow event or durable mutation occurs before a valid Prepared Workflow Graph exists.
- The model-facing schema contains fields the model owns. Session/Project identity, admission audit state, model assignment, and other runtime-derived fields remain hidden.
- Legacy YAML may be adapted at the file boundary without making legacy fields valid inline input.
- Runtime Admission and Workflow Authoring Check have separate names, state, and responsibilities.

## Boundaries

- `WorkflowAuthoring` owns source interpretation and authoring diagnostics.
- `DagWorkflows` owns saved-source discovery, scope precedence, and presentation metadata; it does not decide startability.
- `Dag` owns durable lifecycle invariants, event publication, and runtime transitions for already prepared graphs.
- Provider/Agent/Skill/prompt catalogs own environment facts; the authoring boundary consumes current snapshots without becoming their source of truth.
- Release/config tooling invokes the same portable authoring boundary and adds repository compatibility and packaging gates.

## Decisions

- [ADR-0001: One Workflow Authoring Check authority](docs/adr/0001-workflow-authoring-check.md)
