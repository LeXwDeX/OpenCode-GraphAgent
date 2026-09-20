# S09 task fixture v3 qualification candidate

This candidate leaves the historical v2 task spec unchanged. It corrects two
host-qualification defects before any further real-model sessions are used:
v2 selected 60,000-byte and 55,000-byte reads even though the builtin `read`
tool caps a single result at 50 KiB, and its synthetic turns did not preserve
the host's `step-start` grouping.

The v3 bodies redistribute bytes without reducing each task's intended context
pressure. T1 uses 44,000/13,000/13,000 bytes for `bigfact`/`f01`/`f02`; T2 uses
44,000 bytes for `m01` and 6,000 bytes for every other file; T3 retains its
44,000-byte A-B-A file; T4 uses 44,000 bytes for `a` and 8,000 for `b`.
Generated 44,016-byte injected bodies format to about 47.1 KiB before the small
path/footer envelope.

Prompts define ordered tool groups. Calls in one group share one assistant
tool-call response, while groups wait for the previous results. The prescribed
provider-request counts are T1=8, T2=7, T3=8 and T4=6; every accepted run keeps
the existing hard maximum of 12. At the request where projection is checked,
the designated source is older than the four most recent real host steps, and
the intervening complete read output exceeds the 16,000-token protection
floor. The fixed window remains 81,920/4,096, target 54,476, and minimum net
saving 512 tokens.

Before this candidate can be frozen, the loopback qualification test must pass
through the real HTTP host, builtin tools, stored session history, and production
projection in both enabled and disabled arms. It must identify the designated
source and witness rather than accept an unrelated folded output. Passing this
zero-model test proves fixture eligibility and host wiring; it does not prove a
real model will obey the requested grouping or answer the tasks correctly.

## Local qualification evidence

On 2026-09-20, Bun 1.3.14 ran the loopback qualification against an isolated
`opencode serve` subprocess. T1 first passed independently, then all four tasks
passed together: one test, 242 assertions, and no external provider calls. Both
arms used the exact total provider-request counts T1=8, T2=7, T3=8 and T4=6.
The test asserts the production diagnostic target of 54,476, an input estimate
above target, at least 512 tokens saved, and a successful designated-source
replacement in each enabled arm. Disabled arms preserve every co-present source
and witness. The diagnostic `overBudget` field is evaluated after projection;
its expected value is therefore `false` after a successful fold reaches target.
