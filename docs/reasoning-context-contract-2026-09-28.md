# Kernel reasoning-object distillation and replacement

Date: 2026-09-28. Issue: #671. Status: implementation in progress; no release acceptance claimed.

## User contract

Distill the system kernel's canonical reasoning objects, validate the result, replace their effective content in persistent storage, and let both display and subsequent requests read the replacement. Do not append a second working-memory message or build a separate distillation engine for each SDK. Original source retained for recovery is provenance, not an additional effective context item.

## Evidence baseline

The installed version investigated was 1.0.50, tag commit `ddbebb9d5fd120fc0ec4aceb04dcfba4823ea451`. Implementation starts from dev `76f5a336ab33777065cd96085af9e8c30093c50e`; stable 1.0.51 already includes completed-turn scheduling and durable adoption. The old primary checkout was not used as release-source authority. Graph symbol discovery and tracing were followed by coverage checks; the old indexed worktree is missing, so findings were verified against the tag snapshot and the new dev checkout.

1. Incoming SDK/native events are already normalized into canonical reasoning parts carrying text, IDs, completion state and provider metadata.
2. The ordinary opencode host gates extraction on `interleaved.field`, even though canonical reasoning is present. Its extractor reads an openaiCompatible transport field; the normal OpenRouter conversion intentionally does not use that field. The entry is too tightly coupled to one outbound representation.
3. The pure 1.0.50 projector already preserves its input request. Dev/1.0.51 already atomically persists accepted text with originalText/sourceFingerprint, updates live UI via events, and reloads it. These existing mechanisms must be retained, not recreated.
4. A local synthetic experiment using the pinned OpenRouter SDK 2.9.0 establishes that changing canonical text alone produces new `reasoning` plus old `reasoning_details`; omitting metadata loses reasoning; synchronizing the text mirror produces consistent serialization. This proves serializer behavior only, not upstream compatibility or semantic fidelity.
5. In the target user's local session, 413 observed OpenRouter reasoning parts each contain one plaintext `reasoning.text` detail, identical to canonical text and without signature/data. No user reasoning bodies were exported for this inspection.
6. Existing recursive metadata protection inspection does not traverse arrays. Nested reasoning-detail carriers therefore need a bounded shared structural inspection, not provider-name guesses.

## Architectural decision

The unit of replacement is the **whole canonical reasoning object**, not an SDK field and not a display string:

- authoritative effective text;
- stable session/message/part identity and completion state;
- structured metadata, including precisely bound plaintext mirrors or opaque protocol state;
- original source/provenance and accepted-result status.

The core owns source selection, editability classification, candidate generation/validation, and construction of a consistent replacement. Runtime hosts supply canonical history and perform the existing transactional adoption. SDK/native adapters continue serializing ordinary canonical objects; they do not own distillation rules.

A single shared core helper assesses metadata by structure and binds exact plaintext mirror paths. Another helper constructs a replacement text/metadata pair without mutating input. Both current runtime hosts call these helpers. Existing legacy wire projectors retain explicit compatibility behavior but are no longer the only entry for canonical derivation. No forged compatibility records are used to route around those gates.

## Editability rules

- Only settled, uniquely identified, current eligible source objects may be processed. Repeated text does not establish identity.
- Plain canonical text can be replaced when its carrier contains no protection or ambiguity.
- A recognized plaintext mirror must have a known semantic position, a unique source binding, and exact preimage equality. Update only its recorded path; keep all other metadata, array order and fields unchanged. Never replace arbitrary equal strings in a JSON tree.
- Signatures, encrypted/opaque values, unknown carrier formats, ambiguous multipart mappings, invalid/deep/oversized structures or unresolved source state preserve the whole object with a specific reason. Array traversal is mandatory and bounded.
- Readable content does not prove a signed/opaque carrier is editable. OpenRouter's preservation documentation and provider signature contracts remain relevant even though the business algorithm operates on internal objects. Supported plaintext rewriting requires real isolated upstream evidence before release claims.

Sources: [OpenRouter reasoning preservation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning), [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking).

## Derivation and atomic adoption

Retain existing source spans, coverage, evidence identity/time ordering, scope/negation/uncertainty preservation and independent judge. A source hash is identity evidence, not factual verification; a judge verdict is not proof of equivalence for every future task. The objective is long-task usefulness and continuity, not a target compression ratio.

Obtain source objects directly from persisted canonical history. Host-specific source conversion must not infer eligibility from a transport field or provider name. After validation, generate replacements for the original part IDs. Adoption validates original text and metadata together in the transaction, applies effective text plus coherent metadata, and retains recoverable source provenance. V1/V2 mirrors and events must describe the same object.

Subsequent request conversion uses the effective stored replacement exactly once. There is no appended memory message, altered role, extra instruction or SDK-specific reasoning engine. Disabling the feature must stop new adoption and use a consistent original text/carrier pair where recovery is supported; it must not combine original text with derived metadata or discard history. Legacy records and model changes require explicit tests, not silent reinterpretation.

Every history consumer must receive the same resolved enablement state: ordinary prompts, distillation preparation, title generation, compaction and token estimation. For legacy text-only adoption, replay may rebuild an exactly bound plaintext mirror on a private copy; if that is not possible, it preserves the original pair. New adoption persists both members of the pair together.

Keep completed-turn scheduling, cancellation, retry/revert guards and stale-source comparison. Pending candidate state remains process-local unless deliberately changed; accepted persistent objects must survive reload. This task does not introduce a new global store or platform refactor.

## Verification and delivery

1. Shared object tests: plaintext, exact aliases, unrelated equal strings, nested protected arrays, malformed/unknown/multipart carriers, source IDs, immutable inputs and consistent restore.
2. Both host paths: entry without interleaved.field, no fabricated compatibility records, candidate/judge/gates, atomic adoption, live/reload behavior, cancellation/retry/revert and disable.
3. Pinned SDK/native boundary tests: new canonical object serializes coherent new text/mirrors with preserved shape/order; signed/encrypted carriers unchanged; tool sequence and model-switch behavior remain valid. Mock success is not upstream acceptance.
4. Isolated synthetic real-model session: proposal, judge, adoption, persistent readback and actual subsequent request consumption are separate observations. Do not modify the user's active history. Measure retention and wrong-completion/repeated-action outcomes separately from auxiliary cost and latency.
5. Required local checks and generated artifacts, exact current PR/dev/main CI including stable E2E, then Luna's main workflow dispatch, assets/digests and separately installed runtime. Workflow triggers are not delivery.

## Scope limits

No additive working-memory mode, general retrieval platform, arbitrary metadata text replacement, rewriting of signed/encrypted state, per-model engine, or claim that every SDK representation is editable. The goal is one correct kernel-object replacement mechanism with explicit protected objects and tested serialization boundaries.
