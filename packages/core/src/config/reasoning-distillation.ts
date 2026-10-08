export * as ConfigReasoningDistillation from "./reasoning-distillation"

import { Schema } from "effect"

export class Compatibility extends Schema.Class<Compatibility>("ConfigV2.ReasoningDistillationCompatibility")({
  runtime: Schema.String,
  protocol: Schema.String,
  providerModelVariant: Schema.String,
  endpointIdentity: Schema.String,
  adapterVersion: Schema.String,
  optionsFingerprint: Schema.String,
  transportVerified: Schema.Boolean,
  upstreamVerified: Schema.Boolean,
}) {}

export const Language = Schema.Literals(["zh", "en"])
export type Language = typeof Language.Type

/**
 * Reasoning-distillation switch (default-off). When enabled, settled canonical reasoning without signed, encrypted
 * or unknown provider carriers is organized once per completed turn and the result replaces the stored text.
 * `compatibility` records only gate the legacy native-wire projector; canonical adoption does not consult them.
 */
export class Info extends Schema.Class<Info>("ConfigV2.ReasoningDistillation")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  /** Language of the organized prose; literals such as paths and commands stay verbatim. Defaults to `zh`. */
  language: Language.pipe(Schema.optional),
  compatibility: Compatibility.pipe(Schema.Array, Schema.optional),
}) {}

/** Organizer language; Chinese by default because it is shorter for the same content. */
export const resolveLanguage = (info: Pick<Info, "language"> | undefined): Language => info?.language ?? "zh"

export type EnableSource = "environment" | "config" | "default"

export type EnableResolution = Readonly<{
  enabled: boolean
  source: EnableSource
}>

export type EnableInput = Readonly<{
  /** An environment kill-switch (e.g. OPENCODE_DISABLE_REASONING_DISTILLATION) overrides everything. */
  disabledByEnvironment: boolean
  /** The user's config value, when present. */
  enabled?: boolean
}>

/** Resolve the effective switch without mutating persisted config. Disabled unless explicitly enabled. */
export function resolveEnabled(input: EnableInput): EnableResolution {
  if (input.disabledByEnvironment) return { enabled: false, source: "environment" }
  if (input.enabled !== undefined) return { enabled: input.enabled, source: "config" }
  return { enabled: false, source: "default" }
}
