# Context folding artifact acceptance

This gate exercises the downloaded GraphAgent executable as a real `opencode serve` process against the deterministic
loopback `TestLLMServer`. It does not call an external model.

The two arms prove that duplicate builtin `read` results are folded only when `compaction.dynamic` is enabled, while
the stored session history remains unchanged. The enabled arm also calls the public manual summarize endpoint, checks
that the compaction request contains the original bounded history rather than folding placeholders, and completes one
more turn from the resulting summary.

## Source smoke

Run from `packages/opencode` with the repository-pinned Bun:

```sh
OPENCODE_TEST_CONTEXT_FOLDING_SOURCE=1 \
OPENCODE_TEST_CONTEXT_FOLDING_EVIDENCE_DIR=/private/tmp/graphagent-context-folding-source-evidence \
bun test test/cli/run/context-folding-artifact.test.ts --timeout 200000
```

## Downloaded artifact

Use an absolute executable path and a new private evidence directory:

```sh
OPENCODE_TEST_ARTIFACT_EXECUTABLE=/absolute/path/to/opencode \
OPENCODE_TEST_CONTEXT_FOLDING_EVIDENCE_DIR=/private/tmp/graphagent-context-folding-artifact-evidence \
bun test test/cli/run/context-folding-artifact.test.ts --timeout 200000
```

Artifact mode rejects a missing evidence directory. The CLI harness resolves symlinks, verifies the target is an
executable regular file before each spawn, logs its SHA256, and records the resolved target plus provider transcript in
`enabled.json` and `disabled.json`. Preserve those files with the downloaded archive checksum and release SHA. A source
smoke is development evidence only and does not substitute for rerunning the same gate against the downloaded binary.
