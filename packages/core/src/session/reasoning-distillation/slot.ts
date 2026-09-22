import { Hash } from "../../util/hash"
import type { ReasoningSlotShape, SlotEligibility } from "./types"

/**
 * Reasoning-slot eligibility classification (§2, §2.1). Pure: it maps a slot's observed shape and protection signals
 * plus the host's compatibility records to a SlotEligibility. Protection takes priority over benefit (D05): a slot is
 * rewritable only when it is unsigned, decrypted, settled, structurally rewritable, AND covered by a compatibility
 * record carrying BOTH evidences (local transport test + real upstream comparison). Absent that record the slot stays
 * P5-protected even with the feature default-on (D02, §6.1: "W1 无签名但缺上游兼容记录 -> 默认开关打开也按 P5 保护").
 */

/** The capability tuple a compatibility record binds (§2.1); never includes secrets. */
export type SlotCapability = Readonly<{
  runtime: string
  protocol: string
  providerModelVariant: string
  endpointIdentity: string
  adapterVersion: string
  optionsFingerprint: string
}>

/**
 * A compatibility record. Both evidences are required to authorize rewriting: a mock/transport success alone proves
 * adapter logic, not upstream compatibility (§2.1). Config or adapter changes do not inherit old authorizations.
 */
export type CompatibilityRecord = Readonly<
  SlotCapability & {
    transportVerified: boolean
    upstreamVerified: boolean
  }
>

/** The host's observation of one candidate reasoning slot before eligibility is decided. */
export type SlotAssessment = Readonly<{
  shape: ReasoningSlotShape
  capability: SlotCapability
  /** True when the slot carries a signature/opaque carrier (Anthropic/Bedrock signature) -> P1. */
  signed: boolean
  /** True when the slot is encrypted or an item reference (OpenAI Responses) -> P2. */
  encrypted: boolean
  /** False while streaming, at an unclear step boundary, or with a non-unique source mapping -> P4. */
  settled: boolean
  /** False when required fields/parts/separators/order must be preserved unchanged -> P3. */
  structureRewritable: boolean
}>

const capabilityFingerprintInput = (capability: SlotCapability): string =>
  JSON.stringify([
    capability.runtime,
    capability.protocol,
    capability.providerModelVariant,
    capability.endpointIdentity,
    capability.adapterVersion,
    capability.optionsFingerprint,
  ])

/** Stable fingerprint of a capability tuple; used as the eligibility capabilityFingerprint and cache-key component. */
export const capabilityFingerprint = (capability: SlotCapability): string =>
  Hash.sha256(capabilityFingerprintInput(capability))

const sameCapability = (a: SlotCapability, b: SlotCapability): boolean =>
  a.runtime === b.runtime &&
  a.protocol === b.protocol &&
  a.providerModelVariant === b.providerModelVariant &&
  a.endpointIdentity === b.endpointIdentity &&
  a.adapterVersion === b.adapterVersion &&
  a.optionsFingerprint === b.optionsFingerprint

/** A record authorizes rewriting only when it matches the capability and carries both evidences (§2.1). */
const isAuthorized = (record: CompatibilityRecord, capability: SlotCapability): boolean =>
  record.transportVerified && record.upstreamVerified && sameCapability(record, capability)

/**
 * Classify a slot. Protection classes are checked in priority order P1 > P2 > P4 > P3 > P5; only an unauthorized-but-
 * otherwise-safe slot falls through to P5. The result never presumes safety from a provider name, package, or shape.
 */
export const classifySlotEligibility = (
  slot: SlotAssessment,
  records: readonly CompatibilityRecord[],
): SlotEligibility => {
  if (slot.signed) return { allowed: false, protection: "P1" }
  if (slot.encrypted) return { allowed: false, protection: "P2" }
  if (!slot.settled) return { allowed: false, protection: "P4" }
  if (!slot.structureRewritable) return { allowed: false, protection: "P3" }
  if (records.some((record) => isAuthorized(record, slot.capability))) {
    return { allowed: true, capabilityFingerprint: capabilityFingerprint(slot.capability) }
  }
  return { allowed: false, protection: "P5" }
}
