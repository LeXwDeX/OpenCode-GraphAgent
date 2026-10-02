# Compaction Retry

Compaction times out after 120 seconds without an upstream stream event. It has
no total-generation deadline: reasoning and text events both reset the inactivity
deadline. A reasoning-start event alone does not disable the watchdog. A provider
that thinks silently without sending any events is indistinguishable from a
stalled connection and is subject to the same inactivity deadline.

On inactivity or a provider request timeout (including HTTP 408/504), the current
attempt is cancelled and cleaned up before immediately switching models. There
is no retry backoff for these compaction timeouts. The model order is:

1. The provider's small model, honoring `small_model` when configured.
2. The model configured for `agent.compaction`.
3. The model on the conversation's compaction request.

Unconfigured optional stages and duplicate provider/model pairs are skipped.
Context overflow also advances this ladder. Other failures retain the existing
retry policy. User cancellation does not retry. Once the ladder is exhausted,
compaction reports an error and releases the busy state rather than looping.

Each attempt converts the original summary input for its own model. Discarded
partial summaries are removed; only the final attempt can publish a completed
compaction, run PostCompact hooks, or enqueue an automatic continuation.
