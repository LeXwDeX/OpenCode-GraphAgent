# Graph Engineering workflow catalog

These workflows adapt the useful execution patterns from
[codejunkie99/graph-engineering](https://github.com/codejunkie99/graph-engineering)
to GraphAgent's durable YAML runtime. The source repository is MIT-licensed; its
copyright and license are available in the linked repository. The YAML files here
are project-specific adaptations, not verbatim copies.

The adaptations were cross-checked against the executable examples in
[GraphARC](https://github.com/CodeGraphContext/GraphARC), Anthropic's
[workflow patterns](https://www.anthropic.com/engineering/building-effective-agents)
and [multi-agent production notes](https://www.anthropic.com/engineering/multi-agent-research-system),
plus Google's controlled study on
[when agent teams help or hurt](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/).
No Python or framework runtime was copied.

## Reference graphs

| Workflow | Protected spine | Use it for |
|---|---|---|
| `design-decision-loop` | internal grill → reasoner → fresh audit → PASS-only finalization | Deep development-document work and design-level debugging before implementation |
| `parallel-development-loop` | frozen contract → parallel modules → local audit → wiring → reasoner + verification → parallel review → arbiter | Medium/high-scale project implementation with bounded local correction waves |
| `deep-review-dag-module` | parallel exploration → parallel review → claim verification → arbiter → PASS report or targeted LOOP | Deep review of an already-built subsystem; retarget its lanes to the current project area |
| `change-review` | survey → parallel review/verification → arbiter | A compact fixed review when the medium/high-scale graph would be wasteful |

The project-scoped `reasoner` used by the first two graphs lives at
`.opencode/agent/reasoner.md`. `/dag-flow` selects the closest reference from the
request. Start a saved graph by name only when its embedded target and inputs already
fit. Generic design/development requests must be derived into a one-off DAG with the
actual task injected into the root node; deep review requests retarget the hard-coded
DAG-module lanes unless that module is the real target.

## Agent adaptation contract

1. **Derive, do not blindly replay.** Preserve the reference graph's phase order and real artifact edges, then choose the actual module count, reviewer lanes, and local scope for the task.
2. **Protected nodes cannot be pruned.** Fresh-context review gates, deterministic verification, the single arbiter, and PASS-only finalization always remain. A parent may replace them only with equivalent fresh nodes carrying the same contract.
3. **Every prune is evidence-bearing.** Record `{node, prune_reason, replacement_coverage}`. Missing either field is fail-closed and the next gate must return `BLOCKED`, not silently accept the smaller graph.
4. **Every loop is local and acyclic.** A gate returns `PASS | LOOP | BLOCKED`. `LOOP` identifies the smallest preceding slice to revisit; the parent pauses, replans new correction/review nodes, and resumes. Completed nodes are never restarted in place.
5. **Expansion stays bounded.** New fan-out must have disjoint work or independent context, real downstream consumers, one merge owner, and enough remaining concurrency/node/replan budget.

## Gate disposal rules

| Verdict | Required parent action | Required evidence |
|---|---|---|
| `PASS` | Continue to the next protected phase or finalize | Coverage of every material criterion; no unresolved material finding |
| `LOOP` | Pause, add a fresh local correction/review wave with new node IDs, resume | Reason, minimal `loop_scope`, acceptance condition, `stop_reason` |
| `BLOCKED` | Stop and report; do not reinterpret as advisory success | Missing evidence/decision, unresolved contradiction, no progress, or a reached cap |

These graphs copy topology ideas, not framework code or the upstream repository's
nine disconnected knowledge-graph prompts. The full source comparison and license
notes are in [`docs/graph-engineering-template-research.md`](../../docs/graph-engineering-template-research.md).
