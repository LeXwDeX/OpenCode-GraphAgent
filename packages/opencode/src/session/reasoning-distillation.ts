import {
  estimateContextFoldingBudget,
  fingerprintContextFoldingRequest,
} from "@opencode-ai/core/session/context-folding"
import type { PreparedRequestBudgetInput } from "@opencode-ai/core/session/context-folding"
import {
  classifySlotEligibility,
  planReasoningDistillation,
  projectDistillationRequest,
  ReasoningDistillationPolicy,
  type CallObservation,
  type CallProvenance,
  type CallResultCompleteness,
  type CallStatus,
  type Candidate,
  type ClaimSupport,
  type CompatibilityRecord,
  type DistillationCallQuota,
  type DistillationPlan,
  type DistillationPurpose,
  type DistillationSkipReason,
  type ExecutionTarget,
  type ExecutionVerdictContext,
  type ReasoningEvidence,
  type ReasoningSlotShape,
  type SlotAssessment,
  type SlotCapability,
  type SourceSpan,
  type WireReasoningMapping,
} from "@opencode-ai/core/session/reasoning-distillation"
import { Hash } from "@opencode-ai/core/util/hash"

/**
 * Opencode runtime adapter for reasoning distillation (design §5.2). This module is the host-side bridge between the
 * live wire request and the pure core: it turns provider-extracted observations into the core's ReasoningEvidence and
 * WireReasoningMapping contracts. Provider-specific extraction (AI SDK / native message shapes) and the auxiliary-model
 * propose/judge orchestration are separate concerns; the builders here are pure and unit-tested.
 *
 * Safety: eligibility is decided by the core classifier (§2.1). Without a dual-evidence compatibility record every slot
 * is P5-protected, so the projector never rewrites an unproven provider — the feature is a no-op until §7-3 upstream
 * evidence exists, even when the config switch is on (D02).
 */

/** A reasoning slot as extracted from the final wire request by a provider-specific extractor. */
export type ReasoningSlotObservation = Readonly<{
  messageID: string
  partID: string
  /** Path of the rewritable reasoning text in the final wire request. */
  bodyPath: readonly (string | number)[]
  /** The exact live text at bodyPath; sourceFingerprint binds to it for idempotent projection. */
  text: string
  shape: ReasoningSlotShape
  signed: boolean
  encrypted: boolean
  settled: boolean
  structureRewritable: boolean
}>

/** A tool call as observed in the persisted history within scope; authoritative execution evidence (§5.5.1). */
export type ToolCallObservation = Readonly<{
  messageID: string
  partID: string
  callID: string
  toolName: string
  status: CallStatus
  result: CallResultCompleteness
  inputFingerprint?: string
  provenance: CallProvenance
}>

const byRef = (a: { messageID: string; partID: string }, b: { messageID: string; partID: string }): number =>
  a.messageID < b.messageID
    ? -1
    : a.messageID > b.messageID
      ? 1
      : a.partID < b.partID
        ? -1
        : a.partID > b.partID
          ? 1
          : 0

/**
 * Build the read-only evidence snapshot (R spans + call inventory) the pure core consumes. Each reasoning slot
 * contributes one part-level span covering its full text, emitted in (messageID, partID) order so the core's ordering
 * validation holds. Span fingerprints bind to the exact text; the call inventory is passed through as the authoritative
 * execution evidence. inventoryComplete is the host's proof that the inventory covers the scope; without it the core
 * keeps absence unknown rather than asserting it (§5.5.1).
 */
export const buildReasoningEvidence = (
  slots: readonly ReasoningSlotObservation[],
  calls: readonly ToolCallObservation[],
  inventoryComplete: boolean,
  inventoryFingerprint: string,
): ReasoningEvidence => {
  const spans: SourceSpan[] = slots
    .slice()
    .sort(byRef)
    .map((slot) => ({
      messageID: slot.messageID,
      partID: slot.partID,
      start: 0,
      end: slot.text.length,
      fingerprint: Hash.sha256(slot.text),
    }))
  const observations: CallObservation[] = calls.map((call) => ({
    ref: { messageID: call.messageID, partID: call.partID, callID: call.callID, kind: "tool-result" },
    toolName: call.toolName,
    ...(call.inputFingerprint === undefined ? {} : { inputFingerprint: call.inputFingerprint }),
    status: call.status,
    result: call.result,
    provenance: call.provenance,
  }))
  return { spans, calls: observations, inventoryComplete, inventoryFingerprint }
}

/**
 * Build the wire reasoning mapping for each observed slot, with eligibility decided by the core classifier (§2.1).
 * sourceFingerprint binds the mapping to the exact live text so projectDistillationRequest is idempotent and rejects a
 * drifted or already-projected body. A signed/encrypted/unsettled/structurally-locked slot, or one without a
 * dual-evidence compatibility record, is protected and never rewritable.
 */
export const buildSlotMappings = (
  slots: readonly ReasoningSlotObservation[],
  capability: SlotCapability,
  records: readonly CompatibilityRecord[],
): readonly WireReasoningMapping[] =>
  slots.map((slot) => {
    const assessment: SlotAssessment = {
      shape: slot.shape,
      capability,
      signed: slot.signed,
      encrypted: slot.encrypted,
      settled: slot.settled,
      structureRewritable: slot.structureRewritable,
    }
    return {
      refs: [{ messageID: slot.messageID, partID: slot.partID }],
      shape: slot.shape,
      eligibility: classifySlotEligibility(assessment, records),
      bodyPath: slot.bodyPath,
      sourceFingerprint: Hash.sha256(slot.text),
    }
  })

/**
 * Synchronous AI-SDK projection (§5.2). Builds the evidence snapshot and slot mappings from host-extracted
 * observations, runs the pure plan against the cached candidate/support, and — only when the plan produced eligible
 * replacements — atomically projects them onto the wire request. Propose/judge model calls are NOT made here: per §5.2
 * step 5 the plan signals `extraCall` and the host populates the cache asynchronously, so a trigger that needs a model
 * sends the original this round and projects on a later trigger. Any skip returns the original request object.
 */
export type DistillProjectionInput<Request> = Readonly<{
  request: Request
  identity: unknown
  purpose: DistillationPurpose
  budget: PreparedRequestBudgetInput
  slots: readonly ReasoningSlotObservation[]
  calls: readonly ToolCallObservation[]
  inventoryComplete: boolean
  inventoryFingerprint: string
  capability: SlotCapability
  records: readonly CompatibilityRecord[]
  candidate: Candidate | undefined
  support: readonly ClaimSupport[]
  judgeFingerprint?: string
  quota: DistillationCallQuota
  originalTokens: number | undefined
  targets?: readonly ExecutionTarget[]
  executionContext?: readonly ExecutionVerdictContext[]
}>

export type DistillProjectionResult<Request> = Readonly<{
  request: Request
  applied: boolean
  plan: DistillationPlan
  skipReason: DistillationSkipReason | undefined
}>

export const projectDistillationAISDK = <Request>(
  input: DistillProjectionInput<Request>,
): DistillProjectionResult<Request> => {
  const evidence = buildReasoningEvidence(input.slots, input.calls, input.inventoryComplete, input.inventoryFingerprint)
  const mappings = buildSlotMappings(input.slots, input.capability, input.records)
  const foldingBudget = estimateContextFoldingBudget(input.budget)
  const plan = planReasoningDistillation({
    purpose: input.purpose,
    budget: foldingBudget,
    candidate: input.candidate,
    evidence,
    mappings,
    quota: input.quota,
    originalTokens: input.originalTokens,
    support: input.support,
    ...(input.judgeFingerprint === undefined ? {} : { judgeFingerprint: input.judgeFingerprint }),
    ...(input.targets === undefined ? {} : { targets: input.targets }),
    ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
    policyVersion: ReasoningDistillationPolicy.version,
  })

  if (plan.replacements.length === 0) {
    return { request: input.request, applied: false, plan, skipReason: plan.skipReason }
  }

  const fingerprint = fingerprintContextFoldingRequest({
    request: input.request,
    identity: input.identity,
    budget: input.budget,
  })
  if (!fingerprint.ok) {
    return { request: input.request, applied: false, plan, skipReason: "projection-failed" }
  }
  const projected = projectDistillationRequest<Request>({
    request: input.request,
    identity: input.identity,
    expectedRequestFingerprint: fingerprint.value,
    budget: input.budget,
    replacements: plan.replacements,
  })
  return { request: projected.request, applied: projected.applied, plan, skipReason: projected.skipReason }
}

export * as ReasoningDistillation from "./reasoning-distillation"
