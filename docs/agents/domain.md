# Domain Docs

How engineering skills consume this repository's domain documentation while exploring the codebase.

## Selected layout

This repository uses a **multi-context** layout. `CONTEXT-MAP.md` is the entry point and points to the domain documents relevant to each bounded context.

## Before exploring

1. Read `CONTEXT-MAP.md` at the repository root.
2. Read each linked `CONTEXT.md` relevant to the work.
3. Read system-wide ADRs under `docs/adr/` and context-scoped ADRs linked by the map.

If a referenced directory or document does not exist, proceed silently. Do not create speculative terminology or ADRs merely to fill the layout. `/domain-modeling`, reached through `/grill-with-docs` or `/improve-codebase-architecture`, creates them when terms or decisions are actually resolved.

## File structure

```text
/
├── CONTEXT-MAP.md                    # context index
├── CONTEXT.md                        # existing Session Runtime context
├── docs/adr/                         # system-wide decisions, created lazily
└── packages/<context>/
    ├── CONTEXT.md                    # context vocabulary, created lazily
    └── docs/adr/                     # context decisions, created lazily
```

## Use the glossary vocabulary

When an issue title, refactor proposal, hypothesis, or test names a domain concept, use the term defined in the relevant `CONTEXT.md`. Do not replace a defined term with a synonym that the glossary explicitly avoids.

If the required concept is absent, reconsider whether the project already uses another term. If the gap is real, record it for `/domain-modeling`.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, state the conflict explicitly rather than silently overriding it.
