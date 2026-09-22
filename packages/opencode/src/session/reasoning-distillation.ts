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
  type Claim,
  type ClaimKind,
  type ClaimSupport,
  type ClaimStatus,
  type CompatibilityRecord,
  type CoverageEntry,
  type DistillationCallQuota,
  type DistillationKey,
  type DistillationPlan,
  type DistillationPurpose,
  type DistillationSkipReason,
  type EvidenceKind,
  type EvidenceRef,
  type ExecutionTarget,
  type ExecutionVerdictContext,
  type ModelTier,
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

/**
 * Organizer model tier resolution (§5.6). Propose and judge both resolve small -> agent -> primary, dedup identical
 * models, and run only local availability + context-capability checks (never a probe request). The actual
 * provider/model/variant is fingerprinted into the DistillationKey.organizerFingerprint, and the selected tier plus
 * per-tier fallback reasons are recorded. Returns undefined when no tier is usable (-> model-tier-unresolved).
 */
export type OrganizerModel = Readonly<{
  providerID: string
  modelID: string
  variant?: string
  /** Context-window capability; a model below the auxiliary input+output requirement is skipped (§5.6). */
  contextLimit?: number
}>

export type TierFallback = Readonly<{ tier: ModelTier; reason: "unavailable" | "duplicate" | "insufficient-context" }>

export type TierResolution = Readonly<{
  model: OrganizerModel
  tier: ModelTier
  organizerFingerprint: string
  fallback: readonly TierFallback[]
}>

export const organizerFingerprintOf = (model: OrganizerModel): string =>
  Hash.sha256(JSON.stringify([model.providerID, model.modelID, model.variant ?? null]))

const TIER_ORDER: readonly ModelTier[] = ["small", "agent", "primary"]

export const resolveOrganizerTier = (
  tiers: Readonly<Record<ModelTier, OrganizerModel | undefined>>,
  requiredContextTokens: number,
): TierResolution | undefined => {
  const fallback: TierFallback[] = []
  const seen = new Set<string>()
  for (const tier of TIER_ORDER) {
    const model = tiers[tier]
    if (!model) {
      fallback.push({ tier, reason: "unavailable" })
      continue
    }
    const fingerprint = organizerFingerprintOf(model)
    if (seen.has(fingerprint)) {
      fallback.push({ tier, reason: "duplicate" })
      continue
    }
    seen.add(fingerprint)
    if (model.contextLimit !== undefined && model.contextLimit < requiredContextTokens) {
      fallback.push({ tier, reason: "insufficient-context" })
      continue
    }
    return { model, tier, organizerFingerprint: fingerprint, fallback }
  }
  return undefined
}

/**
 * Defensive parsers for untrusted auxiliary-model output (§5.5.3). The propose/judge models are treated as untrusted
 * data: the parsers enforce a strict shape (known enums, required fields, no reliance on free text), bind span
 * fingerprints through a host resolver (the model cannot compute them), and return undefined on any malformed input so
 * the host falls back to sending the original. They never execute instructions embedded in the output, and the
 * semantic gates re-validate the parsed candidate against R afterwards.
 */

export type RawSpanRef = Readonly<{ messageID: string; partID: string; start: number; end: number }>
export type SpanResolver = (ref: RawSpanRef) => SourceSpan | undefined

const asClaimKind = (value: unknown): ClaimKind | undefined =>
  value === "fact" ||
  value === "constraint" ||
  value === "decision" ||
  value === "rejection" ||
  value === "assumption" ||
  value === "state_delta"
    ? value
    : undefined

const asClaimStatus = (value: unknown): ClaimStatus | undefined =>
  value === "verified" || value === "unverified" || value === "assumed" ? value : undefined

const asEvidenceKind = (value: unknown): EvidenceKind | undefined =>
  value === "instruction" || value === "source" || value === "tool-input" || value === "tool-result" ? value : undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === "string"
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)

const parseSpanRef = (value: unknown): RawSpanRef | undefined => {
  if (!isRecord(value)) return undefined
  const { messageID, partID, start, end } = value
  if (!isString(messageID) || messageID.length === 0) return undefined
  if (!isString(partID) || partID.length === 0) return undefined
  if (!isInt(start) || start < 0) return undefined
  if (!isInt(end) || end <= start) return undefined
  return { messageID, partID, start, end }
}

const parseEvidenceRef = (value: unknown): EvidenceRef | undefined => {
  if (!isRecord(value)) return undefined
  const { messageID, partID, callID } = value
  const kind = asEvidenceKind(value.kind)
  if (!isString(messageID) || !isString(partID) || !kind) return undefined
  if (callID !== undefined && !isString(callID)) return undefined
  return { messageID, partID, kind, ...(callID === undefined ? {} : { callID }) }
}

const parseClaim = (value: unknown, resolveSpan: SpanResolver): Claim | undefined => {
  if (!isRecord(value)) return undefined
  const { id, text, scope, sources, evidence, supersedes } = value
  const kind = asClaimKind(value.kind)
  const status = asClaimStatus(value.status)
  if (!isString(id) || id.length === 0) return undefined
  if (!kind) return undefined
  if (!isString(text)) return undefined
  if (!isString(scope) || scope.length === 0) return undefined
  if (!status) return undefined
  if (!Array.isArray(sources) || sources.length === 0) return undefined
  const resolvedSources: SourceSpan[] = []
  for (const raw of sources) {
    const ref = parseSpanRef(raw)
    if (!ref) return undefined
    const span = resolveSpan(ref)
    if (!span) return undefined
    resolvedSources.push(span)
  }
  if (!Array.isArray(evidence)) return undefined
  const resolvedEvidence: EvidenceRef[] = []
  for (const raw of evidence) {
    const ref = parseEvidenceRef(raw)
    if (!ref) return undefined
    resolvedEvidence.push(ref)
  }
  if (supersedes !== undefined && (!isString(supersedes) || supersedes.length === 0)) return undefined
  return {
    id,
    kind,
    text,
    scope,
    sources: resolvedSources,
    evidence: resolvedEvidence,
    status,
    ...(supersedes === undefined ? {} : { supersedes }),
  }
}

const parseCoverageEntry = (value: unknown, resolveSpan: SpanResolver): CoverageEntry | undefined => {
  if (!isRecord(value)) return undefined
  const srcRef = parseSpanRef(value.source)
  if (!srcRef) return undefined
  const source = resolveSpan(srcRef)
  if (!source) return undefined
  switch (value.action) {
    case "preserve":
      return { source, action: "preserve" }
    case "keep": {
      const { claimID } = value
      if (!isString(claimID) || claimID.length === 0) return undefined
      return { source, action: "keep", claimID }
    }
    case "merge": {
      const witnessRef = parseSpanRef(value.witness)
      if (!witnessRef) return undefined
      const witness = resolveSpan(witnessRef)
      if (!witness) return undefined
      return { source, action: "merge", witness }
    }
    case "drop": {
      const { reason } = value
      if (!isString(reason) || reason.length === 0) return undefined
      return { source, action: "drop", reason }
    }
    default:
      return undefined
  }
}

/** Parse + structurally validate the propose model output into a Candidate; undefined on any malformed shape. */
export const parseCandidate = (
  raw: unknown,
  key: DistillationKey,
  resolveSpan: SpanResolver,
): Candidate | undefined => {
  if (!isRecord(raw)) return undefined
  const { claims, preserved, coverage } = raw
  if (!Array.isArray(claims) || !Array.isArray(preserved) || !Array.isArray(coverage)) return undefined
  const parsedClaims: Claim[] = []
  for (const item of claims) {
    const claim = parseClaim(item, resolveSpan)
    if (!claim) return undefined
    parsedClaims.push(claim)
  }
  const parsedPreserved: SourceSpan[] = []
  for (const item of preserved) {
    const ref = parseSpanRef(item)
    if (!ref) return undefined
    const span = resolveSpan(ref)
    if (!span) return undefined
    parsedPreserved.push(span)
  }
  const parsedCoverage: CoverageEntry[] = []
  for (const item of coverage) {
    const entry = parseCoverageEntry(item, resolveSpan)
    if (!entry) return undefined
    parsedCoverage.push(entry)
  }
  return {
    key,
    fingerprint: Hash.sha256(JSON.stringify(raw)),
    claims: parsedClaims,
    preserved: parsedPreserved,
    coverage: parsedCoverage,
  }
}

/** Parse the judge model output into support verdicts; undefined on malformed output (host then keeps the original). */
export const parseSupport = (raw: unknown): ClaimSupport[] | undefined => {
  if (!isRecord(raw) || !Array.isArray(raw.support)) return undefined
  const parsed: ClaimSupport[] = []
  for (const item of raw.support) {
    if (!isRecord(item)) return undefined
    const { claimID, verdict, method, reasonCode } = item
    if (!isString(claimID) || claimID.length === 0) return undefined
    if (verdict === "unknown") {
      if (!isString(reasonCode)) return undefined
      parsed.push({ claimID, result: { verdict: "unknown", reasonCode } })
      continue
    }
    if (
      (verdict === "supported" || verdict === "contradicted") &&
      (method === "deterministic" || method === "judged")
    ) {
      parsed.push({ claimID, result: { verdict, method } })
      continue
    }
    return undefined
  }
  return parsed
}

export * as ReasoningDistillation from "./reasoning-distillation"
