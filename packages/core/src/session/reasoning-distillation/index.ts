export { assembleAudit, gateViolationToFinding, resolveExecutionMatch, resolveExecutionVerdict } from "./audit"
export type { ExecutionVerdictInput } from "./audit"
export {
  admitPaidCandidate,
  canJudge,
  canPropose,
  consumeJudge,
  consumePropose,
  emptyCallLedger,
  emptyDiagnostics,
  quotaIdentity,
  usageExceedsReserve,
} from "./budget"
export type { CallLedger, CostEstimate, DistillationDiagnostics, IdentityUsage, UsageRecord } from "./budget"
export { cacheInsert, cacheKeyFingerprint, cacheLookup, emptyCache, isCertificateCurrent } from "./cache"
export type { CacheEntry, DistillationCache } from "./cache"
export {
  claimEquivalence,
  spanKey,
  validateClaim,
  validateClaimSet,
  validateCoverage,
  validateSourceSpans,
} from "./claims"
export { evaluateGates } from "./gates"
export type { GateEvaluation, GateID, GateViolation } from "./gates"
export { planReasoningDistillation } from "./plan"
export { ReasoningDistillationPolicy } from "./policy"
export type {
  AuditConfidence,
  AuditFinding,
  AuditRecord,
  AuditSubject,
  AuditViolationKind,
  CallObservation,
  CallProvenance,
  CallResultCompleteness,
  CallStatus,
  Candidate,
  Claim,
  ClaimKind,
  ClaimStatus,
  ClaimSupport,
  CoverageEntry,
  DistillationCallQuota,
  DistillationDependencies,
  DistillationExtraCall,
  DistillationKey,
  DistillationPlan,
  DistillationPlanInput,
  DistillationPlanReplacement,
  DistillationPurpose,
  DistillationSkipReason,
  EvidenceKind,
  EvidenceRef,
  ExecutionExpectation,
  ExecutionMatch,
  ExecutionMatchUnknownReason,
  ExecutionModality,
  ExecutionScope,
  ExecutionSelector,
  ExecutionTarget,
  ExecutionVerdictContext,
  ModelProjection,
  ModelTier,
  ProtectionClass,
  ReasoningEvidence,
  ReasoningSlotShape,
  SlotEligibility,
  SourceRef,
  SourceSpan,
  SupportMethod,
  SupportResult,
  SupportVerdict,
  ValidationStamp,
  WireReasoningMapping,
} from "./types"
