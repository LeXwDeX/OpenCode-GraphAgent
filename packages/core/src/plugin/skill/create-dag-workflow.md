<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts (CreateDagWorkflowDescription). The body
  below becomes the skill's content.
-->

# Creating a saved DAG workflow

A saved workflow is a YAML spec that lives on disk under a name, so a recurring
multi-agent procedure can be started with one call instead of being redesigned
every time. This skill covers authoring one. The `workflow` tool's own
documentation covers graph semantics — read it for node fields, collaboration
patterns, and replanning.

## Where the file goes

| Scope | Path | Use when |
|---|---|---|
| Project | `.opencode/workflows/<name>.yaml` | The procedure depends on this repo (its packages, its test commands, its review rules). Committed, so the whole team gets it. |
| Global | `<opencode config dir>/workflows/<name>.yaml` | The procedure is repo-agnostic (a generic review or research pattern). Available in every project. |

The opencode config dir is `~/.config/opencode` on Linux/macOS unless
`OPENCODE_CONFIG_DIR` redirects it. Ask the user which scope they want when the
answer is not obvious from the request; a repo-specific graph in the global
scope will break in other projects.

**The name is the filename stem.** `.opencode/workflows/code-review.yaml`
starts as `workflow(action: "start", spec_path: "code-review")`. Use kebab-case
and no path separators. A project file shadows a global one with the same name.

## Before writing the file

Do not invent the graph. Establish these with the user first — a saved workflow
gets reused, so a wrong assumption gets repeated:

1. **The trigger.** What does the user say to run this? That phrasing should be recognizable in the workflow's `title`.
2. **The phases.** Which steps genuinely depend on an earlier step's output, and which are independent? Only real data dependencies become `depends_on` edges; everything else runs in parallel.
3. **The gate.** Is there a point where downstream work must not start until quality is confirmed? That becomes a node with `output_schema` returning a verdict plus a `condition` on its dependents.
4. **The inputs.** Does the graph need per-run values (a target module, a diff range)? A saved spec is static, so express them as static `prompt_template.input` defaults and state in the node prompt that the parent may narrow the target — or keep the node prompt broad enough to work unchanged.
5. **The finish.** What does a successful run produce, and which node reports it? Give that node `report_to_parent: true`.

## File shape

```yaml
title: Code review workflow
config:
  name: code-review
  max_concurrency: 5
  node_defaults:
    required: false
    report_to_parent: false
    worker_config:
      timeout_ms: 600000
  nodes:
    - id: explore
      name: explore
      worker_type: explore
      depends_on: []
      required: true
      prompt_template:
        id: code-explore
        input:
          target: "the packages changed in the working tree"

    - id: review-logic
      name: review-logic
      worker_type: general
      depends_on: [explore]
      prompt_template: { id: review-logic }

    - id: review-arch
      name: review-arch
      worker_type: general
      depends_on: [explore]
      prompt_template: { id: review-arch }

    - id: arbitrate
      name: arbitrate
      worker_type: general
      depends_on: [review-logic, review-arch]
      required: true
      report_to_parent: true
      output_schema:
        type: object
        required: [verdict, summary, findings]
        properties:
          verdict:
            type: string
            enum: [ACCEPT, REVISE, REJECT, BLOCKED]
          summary: { type: string }
          findings: { type: array }
      prompt_template:
        inline: "Two reviewers produced findings. Submit one deduplicated verdict with evidence-backed findings."
```

`title` and `config` sit at the file root. A deep workflow adds `mode: deep`
and an `admission` block at the same level — but admission answers are
per-request, so a saved spec is usually `standard`; let the parent run the
admission Q&A and write a one-off deep spec when depth is needed.

## Rules that a saved spec must respect

- **Never write `model` on a node or in `node_defaults`.** Model choice is configuration-owned: `dag.jsonc` supplies the `advanced` tier for `required: true` and review nodes, `standard` for the rest, then the agent model, then the parent session model. A saved spec that pins a model breaks on machines without it.
- **Every `worker_type` must exist** as a built-in (`explore`, `build`, `general`, `plan`) or a configured agent. A custom agent name makes the workflow project-scoped in practice, even if the file sits in the global directory.
- **Referenced `prompt_template.id` must exist** under `.opencode/dag-prompts/`. A global workflow referencing a repo-local template will fail at spawn in other projects — use `inline` prompts there.
- **Supply every required template variable.** An unresolved `{{var}}` fails the node loudly at spawn, so a missing input turns into a broken run, not a degraded one.
- **No cycles, no dangling `depends_on` ids.** Both are rejected at creation.
- **Terminal nodes are immutable at runtime.** Design retries as new nodes added by a replan, not as in-place restarts of finished ones.

## Verify it

A spec is only proven by a real start. After writing the file:

1. `workflow(action: "list")` — confirm the name resolves and the reported node count matches the file. A file missing from the listing is in the wrong directory or has the wrong extension (`.yaml`/`.yml` only).
2. `workflow(action: "start", spec_path: "<name>")` on a small, real target. Schema and graph validation happen here: an invalid spec fails the start with the offending field, and no workflow is created.
3. Read the wake report when it arrives. A graph that "succeeded" while its fan-in node produced an empty synthesis is not working — check that the reporting node's output actually contains the comparison or decision the procedure exists to produce.

Fix the file and start again; do not patch a running workflow to compensate for
a spec bug. Tell the user the workflow is saved, where it lives, and the exact
phrase that starts it.
