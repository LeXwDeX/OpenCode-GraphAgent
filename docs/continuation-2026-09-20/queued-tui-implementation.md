# Issue #615 queued TUI message implementation evidence

This note records the bounded local implementation for Issue #615. It contains no workstation paths, credentials, deployment data, or user transcript content.

## Durable admission receipt

- `SessionV1.User.time.consumed?: number` is the durable receipt.
- `SessionPrompt` takes the existing per-session admission lock, freezes the compacted message snapshot, and writes `consumed` once to every ordinary user in that snapshot before title, compaction, assistant creation, provider work, or other derived work.
- Queued edit/delete take the same lock and transaction. A defined receipt rejects both operations, including `0`.
- The projector preserves the greatest defined receipt when a stale whole-message update arrives. It reads the previous JSON only for user messages, leaving assistant streaming updates on the existing hot path.
- Assistant parent ordering is a conservative legacy rejection signal. It is not the receipt for newly claimed messages; dangling parent history fails closed.

## Mutation contract

- PATCH and DELETE use `/session/:sessionID/message/:messageID/queued`.
- Both require the frozen `partID`, `expectedText`, and ordered `expectedPartIDs`; PATCH also requires replacement `text`.
- Only one ordinary, non-synthetic text part is editable. Message/part IDs, attachment parts, their order, agent/model metadata, and creation order remain unchanged.
- Declared HTTP results are 400 for invalid targets/payloads, 404 for absent messages, 409 for consumed/stale/not-queued/uncertain history, and 200 for successful edit/delete.
- Domain errors remain in the Effect error channel across the database transaction; only `SqlError` becomes a defect.

## UI behavior

- The queued helper compares timestamp then ID and hides queued actions immediately when `time.consumed` is present.
- The dialog captures an immutable expected snapshot before opening Edit or Delete confirmation. Reactive store changes while the dialog is open therefore produce a server 409 and cannot overwrite text, accept new attachments, or delete the message.
- Queued messages show Edit/Delete/Copy. Other messages retain Revert/Copy/Fork.

## Local evidence

- Core projector: 10 passed, including stale/lower/missing receipt updates and `consumed=0`.
- TUI helper: 3 passed, including consumed visibility and immutable attachment snapshot.
- Prompt runtime: edit before claim changes the next input; delete before claim removes the prompt from the next input; all ordinary users in one snapshot are marked; edit/delete reject after claim but before assistant persistence; abort and stale updates preserve receipt; manual compaction claims ordinary users before summary work.
- HTTP: successful PATCH/DELETE plus declared 400/404/409 mappings; stale text and attachment changes reject without overwrite or deletion.
- HttpApi exerciser includes PATCH and DELETE route scenarios; coverage, auth, and effect modes each passed 232 scenarios with zero fail/skip/missing/extra.
- Both client generators were run. `packages/sdk/js` produced the legacy session route methods and `consumed` type; V2 `packages/client` had no diff because it generates the separate `/api/session` surface.
- Root typecheck passed 29/29 tasks. Root lint passed with 4,849 warnings and zero errors under the existing 4,850 ratchet.

CI/CD, push, merge, artifact publication, deployment, and test-environment acceptance remain outside this local development phase.
