# Context Map

Read the context documents relevant to the code or decision under review. Do not load unrelated contexts by default.

| Context | Domain document | Primary areas |
| --- | --- | --- |
| Session Runtime and Client Contract | [`CONTEXT.md`](CONTEXT.md) | `packages/opencode/src/session`, `packages/opencode/src/system-context`, `packages/protocol`, `packages/client`, `packages/sdk` |
| Workflow Orchestration | [`packages/opencode/src/dag/CONTEXT.md`](packages/opencode/src/dag/CONTEXT.md) | `packages/opencode/src/dag`, workflow tool, DAG template validation and packaging |

## Contexts created lazily

Add future contexts to this map only when they have a stable document to reference.
