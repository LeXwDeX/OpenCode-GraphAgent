import { Schema } from "effect"

/** Host-owned adoption provenance, separate from provider metadata and model context. */
export const ReasoningDistillation = Schema.Struct({
  originalText: Schema.String,
  sourceFingerprint: Schema.String,
}).annotate({ identifier: "ReasoningDistillation" })
export type ReasoningDistillation = typeof ReasoningDistillation.Type
