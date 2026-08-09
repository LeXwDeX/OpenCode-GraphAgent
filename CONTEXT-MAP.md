# Context Map

Read the context documents relevant to the code or decision under review. Do not load unrelated contexts by default.

| Context | Domain document | Primary areas |
| --- | --- | --- |
| Session Runtime and Client Contract | [`CONTEXT.md`](CONTEXT.md) | `packages/opencode/src/session`, `packages/opencode/src/system-context`, `packages/protocol`, `packages/client`, `packages/sdk` |

## Contexts created lazily

DAG orchestration does not yet have a dedicated `CONTEXT.md`. The full DAG review must establish terminology from implementation, tests, existing specifications, and accepted decisions before `/domain-modeling` creates one. Add future contexts to this map only when they have a stable document to reference.
