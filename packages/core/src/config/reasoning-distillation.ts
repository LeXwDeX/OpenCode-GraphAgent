export * as ConfigReasoningDistillation from "./reasoning-distillation"

import { Schema } from "effect"

/**
 * Reasoning-distillation switch (design D02: default-on, but compatibility authorization still defaults to protected).
 * The feature only ever rewrites a reasoning slot that carries a §2.1 dual-evidence compatibility record; absent that
 * record every slot is P5-protected, so enabling the switch is safe and never rewrites an unproven provider.
 */
export class Info extends Schema.Class<Info>("ConfigV2.ReasoningDistillation")({
  enabled: Schema.Boolean.pipe(Schema.optional),
}) {}

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

/** Resolve the effective switch without mutating persisted config. Default-on per D02 unless disabled. */
export function resolveEnabled(input: EnableInput): EnableResolution {
  if (input.disabledByEnvironment) return { enabled: false, source: "environment" }
  if (input.enabled !== undefined) return { enabled: input.enabled, source: "config" }
  return { enabled: true, source: "default" }
}
