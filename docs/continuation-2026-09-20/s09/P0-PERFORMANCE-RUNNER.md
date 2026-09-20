# P0 production-adapter performance runner

`packages/core/script/context-folding-performance.ts` measures the production `CoreContextFolding.project` adapter with
deterministic 1,000,000-byte and 7,500,000-byte prepared requests. Both fixtures contain an old duplicate source, its
later exact witness, and four recent protected steps. No provider or model process is contacted.

The disabled arm is deliberately limited to `estimateContextFoldingBudget` over the independently copied prepared
provider body. The enabled arm includes the production history scan, equality and binding checks, request copies,
budget calculation, fingerprints, projection, the second provider prepare, and prepared-wire witness verification.
Each repetition runs both arms on the same fixture, alternates their order, and stores the signed `enabled - disabled`
delta. Every enabled result is checked outside the timed interval for actual folding, a smaller projected request, an
unchanged source request/history, and an exact witness.

RSS is measured in a fresh child process per size. A worker thread constructs the fixture, loads the ledger, runs GC,
then sets a shared atomic ready flag. The main thread records the process's current RSS as the baseline, starts a 1 ms
sampler, and releases the worker through the same atomic handshake. The sampled peak includes three full adapter runs
and the subsequent evidence hashes/JSON preparation, so it is a conservative upper bound. The sampler and worker share
one process and one RSS value. A transient shorter than the scheduler's effective sampling interval can be missed; the
raw file records the requested interval and sample count. Neither historical `maxRSS` nor a high-water-minus-high-water
calculation is used.

Run a non-gating harness smoke from the repository root:

```bash
PATH=/private/tmp/graphagent-bun-1.3.14/bun-darwin-aarch64:$PATH \
  bun packages/core/script/context-folding-performance.ts \
  --smoke \
  --raw-dir /tmp/graphagent-s09-p0-smoke \
  --summary /tmp/graphagent-s09-p0-smoke/summary.json
```

The smoke uses only one warmup and two measured pairs, so its summary must not be submitted to the performance gate.
For the final integrated, source-clean candidate, omit `--smoke`, save the raw directory outside the repository, and
then run the fail-closed gate:

```bash
PATH=/private/tmp/graphagent-bun-1.3.14/bun-darwin-aarch64:$PATH \
  bun packages/core/script/context-folding-performance.ts \
  --raw-dir /tmp/graphagent-s09-p0-final \
  --summary /tmp/graphagent-s09-p0-final/summary.json

PATH=/private/tmp/graphagent-bun-1.3.14/bun-darwin-aarch64:$PATH \
  bun docs/continuation-2026-09-20/s09/scripts/performance-gate.ts \
  /tmp/graphagent-s09-p0-final/summary.json
```

The raw JSON contains numeric timing pairs, RSS counters, booleans, hashes, runtime/load data, and a candidate manifest;
it contains no prompt, tool output, provider identity, session identifier, configuration path, or credential. The runner
reads the candidate SHA from `git rev-parse HEAD`, refuses a formal run with dirty tracked/source files, and hashes the
runner, gate, prepared inputs, canonical requests, and source histories. Untracked continuation evidence under this S09
directory is counted separately because it does not participate in runtime resolution.

The wire serializer now emits canonical JSON chunks once through a single shared work budget. Key ordering, canonical
bytes, input/node/container/depth checks, rejected values, and policy constants remain unchanged. `maxOutputCharacters`
now counts each emitted canonical character once instead of repeatedly charging the same intermediate child string at
every enclosing level. This allows the frozen 7.5 MiB class to reach the full production adapter without increasing any
configured work limit.
