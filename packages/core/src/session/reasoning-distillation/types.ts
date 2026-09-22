import type { ContextFoldingBudget } from "../context-folding/types"

/**
 * Data contracts for reasoning distillation (design §5.3). These are pure types; runtime schema validation
 * enforces non-empty arrays, value ranges, fingerprint consistency, and discriminated-union constraints.
 * Per §5.4.1 every model-facing rendering (ModelProjection.text, Claim.text, Claim.scope, preserved prose)
 * is Chinese, while technical identifiers (paths, commands, symbols, code literals, callID, URL, config keys,
 * version numbers, numeric values) are preserved verbatim. Internal diagnostic enums stay English.
 */

export type SourceRef = Readonly<{
  messageID: string
  partID: string
}>

export type SourceSpan = Readonly<
  SourceRef & {
    /** UTF-16 [start, end), relative to the original part text. */
    start: number
    end: number
    fingerprint: string
  }
>

export type EvidenceKind = "instruction" | "source" | "tool-input" | "tool-result"

export type EvidenceRef = Readonly<
  SourceRef & {
    kind: EvidenceKind
    callID?: string
  }
>

export type ClaimKind = "fact" | "constraint" | "decision" | "rejection" | "assumption" | "state_delta"

export type ClaimStatus = "verified" | "unverified" | "assumed"

export type Claim = Readonly<{
  id: string
  kind: ClaimKind
  text: string
  /** Required; preserves time, environment, object, and condition. "Unknown scope" must be preserved verbatim or skipped. */
  scope: string
  sources: readonly SourceSpan[]
  evidence: readonly EvidenceRef[]
  status: ClaimStatus
  /** Points at a superseded claim id; the target keeps its identity, original text, and scope. Must not dangle. */
  supersedes?: string
}>

export type ExecutionModality = "reported" | "required"

export type ExecutionSelector =
  | Readonly<{ kind: "call"; callID: string }>
  | Readonly<{ kind: "at-least-one" }>
  | Readonly<{ kind: "all" }>

export type ExecutionExpectation = "invoked" | "succeeded"

export type ExecutionScope = Readonly<{
  messageIDs: readonly string[]
  stepIDs: readonly string[]
  settled: boolean
}>

export type ExecutionTarget = Readonly<{
  id: string
  /** A requirement-only target need not appear in the reasoning. */
  claimID?: string
  modality: ExecutionModality
  requiredBy: readonly SourceRef[]
  toolName: string
  inputFingerprint?: string
  selector: ExecutionSelector
  expectation: ExecutionExpectation
  scope: ExecutionScope
}>

export type CallStatus = "pending" | "running" | "completed" | "error" | "interrupted" | "unknown"

export type CallResultCompleteness = "complete" | "truncated" | "compacted" | "missing"

export type CallProvenance = "corroborated" | "unavailable"

export type CallObservation = Readonly<{
  ref: Readonly<EvidenceRef & { callID: string }>
  toolName: string
  inputFingerprint?: string
  status: CallStatus
  result: CallResultCompleteness
  provenance: CallProvenance
}>

export type ExecutionMatchUnknownReason = "incomplete-inventory" | "ambiguous-target" | "unsettled-scope"

export type ExecutionMatch =
  | Readonly<{ kind: "matched"; calls: readonly CallObservation[] }>
  | Readonly<{ kind: "absent"; inventoryFingerprint: string }>
  | Readonly<{ kind: "unknown"; reason: ExecutionMatchUnknownReason }>

export type SupportVerdict = "supported" | "contradicted" | "unknown"

export type SupportMethod = "deterministic" | "judged"

export type SupportResult =
  | Readonly<{ verdict: "supported" | "contradicted"; method: SupportMethod }>
  | Readonly<{ verdict: "unknown"; reasonCode: string }>

export type ReasoningSlotShape = "interleaved-field" | "unsigned-reasoning" | "downgraded-text"

export type ProtectionClass = "P1" | "P2" | "P3" | "P4" | "P5"

export type SlotEligibility =
  | Readonly<{ allowed: true; capabilityFingerprint: string }>
  | Readonly<{ allowed: false; protection: ProtectionClass }>

export type WireReasoningMapping = Readonly<{
  refs: readonly SourceRef[]
  shape: ReasoningSlotShape
  eligibility: SlotEligibility
  bodyPath: readonly (string | number)[]
  sourceFingerprint: string
}>

export type ModelTier = "small" | "agent" | "primary"

export type DistillationKey = Readonly<{
  sessionID: string
  messageID: string
  partIDs: readonly string[]
  sourceFingerprint: string
  capabilityFingerprint: string
  /** Actual provider/model/variant/options, not only tier. */
  organizerFingerprint: string
  policyVersion: string
}>

export type CoverageEntry =
  | Readonly<{ source: SourceSpan; action: "keep"; claimID: string }>
  | Readonly<{ source: SourceSpan; action: "preserve" }>
  | Readonly<{ source: SourceSpan; action: "merge"; witness: SourceSpan }>
  | Readonly<{ source: SourceSpan; action: "drop"; reason: string }>

export type Candidate = Readonly<{
  key: DistillationKey
  fingerprint: string
  /** Status and evidence remain proposals until validation. */
  claims: readonly Claim[]
  /** Meaningful text that cannot safely be classified. */
  preserved: readonly SourceSpan[]
  coverage: readonly CoverageEntry[]
}>

export type ValidationStamp = Readonly<{
  candidateFingerprint: string
  evidenceFingerprint: string
  capabilityFingerprint: string
  validatorVersion: string
  /** Required when method is judged. */
  judgeFingerprint?: string
  method: SupportMethod
}>

export type ModelProjection = Readonly<{
  claims: readonly Claim[]
  preserved: readonly SourceSpan[]
  /** Rendered only from validated claims and preserved source spans; Chinese prose, identifiers verbatim (§5.4.1). */
  text: string
}>

export type AuditViolationKind =
  | "fabricated"
  | "concealed"
  | "simulated_execution"
  | "unbacked_completion"
  | "evidence_swap"
  | "unverifiable"

export type AuditSubject = "source-agent" | "distiller"

export type AuditConfidence = "deterministic" | "judged" | "unverifiable"

export type AuditFinding = Readonly<{
  kind: AuditViolationKind
  claimID?: string
  /** At least one of claimID / targetID must resolve. */
  targetID?: string
  evidence: readonly EvidenceRef[]
  confidence: AuditConfidence
  reasonCode: string
}>

export type AuditRecord = Readonly<{
  subject: AuditSubject
  findings: readonly AuditFinding[]
}>

export type DistillationPlanReplacement = Readonly<{
  mapping: WireReasoningMapping
  projection: ModelProjection
  validation: ValidationStamp
  estimatedSavings: number
}>

export type DistillationExtraCall = "none" | "propose" | "judge"

/**
 * Closed skip-reason enum (§5.3). Retains the applicable budget/mapping reasons and adds the distillation-specific
 * ones; never blindly copies tool source/witness-only reasons.
 */
export type DistillationSkipReason =
  | "below-target"
  | "unknown-content"
  | "work-limit"
  | "invalid-reference"
  | "mapping-mismatch"
  | "stale-request"
  | "projection-failed"
  | "no-rewritable-slot"
  | "compatibility-unproven"
  | "retention-contract-violated"
  | "new-assertion"
  | "evidence-unresolved"
  | "semantic-review-required"
  | "model-tier-unresolved"
  | "call-budget-exhausted"
  | "attempt-exhausted"
  | "insufficient-net-savings"
  | "stale-validation"

export type DistillationPlan = Readonly<{
  replacements: readonly DistillationPlanReplacement[]
  audit: readonly AuditRecord[]
  reusedCandidates: readonly DistillationKey[]
  extraCall: DistillationExtraCall
  skipReason?: DistillationSkipReason
}>

/** Request purpose classification (§5.1). Only conversation and compaction may distill. */
export type DistillationPurpose = "conversation" | "compaction" | "auxiliary" | "unknown"

/**
 * Read-only evidence snapshot the pure functions consume (§5.2). The host supplies the persisted-history spans (R),
 * the authoritative call inventory (E), and its completeness proof; pure functions never perform I/O.
 */
export type ReasoningEvidence = Readonly<{
  /** Ordered, non-overlapping spans locating R in the original parts. */
  spans: readonly SourceSpan[]
  /** Persisted call inventory within scope; authoritative for execution matching. */
  calls: readonly CallObservation[]
  /** Host proof that the inventory completely covers the scope; without it, absence stays unknown. */
  inventoryComplete: boolean
  inventoryFingerprint: string
}>

/** Per-source-identity call quota (§5.8): propose at most once, judge at most once, never reset by fingerprint change. */
export type DistillationCallQuota = Readonly<{
  proposeUsed: boolean
  judgeUsed: boolean
}>

/**
 * Host-supplied support verdict for one claim. The judge (or a deterministic predicate) runs outside the pure plan;
 * the plan only consumes these results to decide G4 and whether semantic review is still required.
 */
export type ClaimSupport = Readonly<{
  claimID: string
  result: SupportResult
}>

/**
 * Host-supplied context for auditing one execution target (§5.5). The host derives execution targets from the
 * reasoning and supplies whether the source honestly states failure plus the targeted support verdict; the pure plan
 * only resolves the match and the exclusive verdict.
 */
export type ExecutionVerdictContext = Readonly<{
  targetID: string
  sourceStatesFailure: boolean
  support: SupportResult
}>

export type DistillationPlanInput = Readonly<{
  purpose: DistillationPurpose
  /** Reuses the folding budget; the trigger is overBudget === true (§5.1). */
  budget: ContextFoldingBudget
  candidate: Candidate | undefined
  evidence: ReasoningEvidence
  mappings: readonly WireReasoningMapping[]
  quota: DistillationCallQuota
  /** Host estimate of the original reasoning slot tokens; undefined means savings cannot be computed. */
  originalTokens: number | undefined
  /** Support verdicts for the candidate's claims, from cache or a prior judge call. */
  support: readonly ClaimSupport[]
  /** Identity of the judge that produced any `judged` support; required when a validation stamp is `judged`. */
  judgeFingerprint?: string
  /** Optional execution targets to audit (§5.5); empty means no execution audit this round. */
  targets?: readonly ExecutionTarget[]
  /** Per-target verdict context for the execution audit. */
  executionContext?: readonly ExecutionVerdictContext[]
  policyVersion: string
}>

/** Injected seams keep the plan pure; the real renderer/tokenizer/fingerprint arrive in later phases. */
export type DistillationDependencies = Readonly<{
  /** Host original-text parser (§5.5.3); the renderer uses it to faithfully reproduce preserved spans. */
  resolveText?: (span: SourceSpan) => string
  /** §5.5.3 renderer: receives only validated claims, preserved spans, and the text resolver, never audit data. */
  render?: (
    claims: readonly Claim[],
    preserved: readonly SourceSpan[],
    resolveText: (span: SourceSpan) => string,
  ) => string
  /** Token estimator for the savings gate; defaults to a conservative character proxy. */
  estimateTokens?: (text: string) => number
  fingerprint?: (value: string) => string
}>
