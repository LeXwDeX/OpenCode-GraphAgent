import { Schema } from "effect"

/** Host-owned adoption provenance, separate from provider metadata and model context. */
export const ReasoningDistillation = Schema.Struct({
  originalText: Schema.String,
  sourceFingerprint: Schema.String,
  /** Version 2 records include the original carrier pair. Missing means a legacy record. */
  version: Schema.Literal(2).pipe(Schema.optional),
  originalMetadata: Schema.Record(Schema.String, Schema.Any).pipe(Schema.optional),
}).annotate({ identifier: "ReasoningDistillation" })
export type ReasoningDistillation = typeof ReasoningDistillation.Type
