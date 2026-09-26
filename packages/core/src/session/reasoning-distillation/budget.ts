import { ReasoningDistillationPolicy } from "./policy"
import type { DistillationKey } from "./types"

/**
 * Unified call budget and cost accounting (§5.8). Propose, judge, real failures, and retries all count as extra model
 * calls; the existing tool folding needs no model and the full-text summary is metered separately. Immutable: each
 * consumption returns a new ledger. The quota is keyed by SOURCE identity, so a model/endpoint/variant or evidence
 * fingerprint change does not reset it (§5.8: "模型或证据指纹变化不重置该配额"), and quota is consumed before the call
 * so concurrency/cancellation/late results never double-spend or revive it (§6.1).
 */

export type IdentityUsage = Readonly<{ propose: number; judge: number }>

export type CallLedger = Readonly<{
  byIdentity: Readonly<Record<string, IdentityUsage>>
}>

export const emptyCallLedger: CallLedger = { byIdentity: {} }

const SEP = "\u0000"

/**
 * The quota identity is the SOURCE reasoning identity only — session, message, parts, and source fingerprint. It
 * deliberately excludes capability/organizer/evidence fingerprints so a model or evidence change cannot reset quota.
 */
export const quotaIdentity = (key: DistillationKey): string =>
  [key.sessionID, key.messageID, key.partIDs.join(","), key.sourceFingerprint].join(SEP)

const usageOf = (ledger: CallLedger, key: DistillationKey): IdentityUsage =>
  ledger.byIdentity[quotaIdentity(key)] ?? { propose: 0, judge: 0 }

const totalCalls = (usage: IdentityUsage): number => usage.propose + usage.judge

export const canPropose = (ledger: CallLedger, key: DistillationKey): boolean => {
  const usage = usageOf(ledger, key)
  return (
    usage.propose < ReasoningDistillationPolicy.calls.maxProposePerIdentity &&
    totalCalls(usage) < ReasoningDistillationPolicy.calls.maxCallsPerIdentity
  )
}

export const canJudge = (ledger: CallLedger, key: DistillationKey): boolean => {
  const usage = usageOf(ledger, key)
  return (
    usage.judge < ReasoningDistillationPolicy.calls.maxJudgePerIdentity &&
    totalCalls(usage) < ReasoningDistillationPolicy.calls.maxCallsPerIdentity
  )
}

const consume = (ledger: CallLedger, key: DistillationKey, role: "propose" | "judge"): CallLedger => {
  const identity = quotaIdentity(key)
  const usage = ledger.byIdentity[identity] ?? { propose: 0, judge: 0 }
  return {
    byIdentity: { ...ledger.byIdentity, [identity]: { ...usage, [role]: usage[role] + 1 } },
  }
}

/** Consume quota before the call is issued; a failed or cancelled call still counts (§5.8). */
export const consumePropose = (ledger: CallLedger, key: DistillationKey): CallLedger => consume(ledger, key, "propose")
export const consumeJudge = (ledger: CallLedger, key: DistillationKey): CallLedger => consume(ledger, key, "judge")

/**
 * Paid-candidate admission (§5.8): conservatively admit only when the amortized future saving over at most
 * `amortizationWindow` subsequent real sends exceeds the worst-case auxiliary cost. This is a falsifiable prediction
 * in tokens; it never books unsent future sends as realized benefit, and an unknown price/metering basis records
 * tokens only without claiming a monetary net benefit.
 */
export type CostEstimate = Readonly<{
  singleSavingTokens: number
  proposeWorstCaseTokens: number
  judgeWorstCaseTokens: number
}>

export const admitPaidCandidate = (estimate: CostEstimate): boolean => {
  const futureSaving = ReasoningDistillationPolicy.calls.amortizationWindow * estimate.singleSavingTokens
  const worstCaseCost = estimate.proposeWorstCaseTokens + estimate.judgeWorstCaseTokens
  return futureSaving > worstCaseCost
}

/**
 * Usage accounting (§6.1): a real overage or unknown metering pauses further paid admission rather than pretending the
 * true cumulative usage is still within the estimate.
 */
export type UsageRecord = Readonly<{
  reservedTokens: number
  /** undefined means the provider did not report usage (metering unknown). */
  actualTokens: number | undefined
}>

export const usageExceedsReserve = (record: UsageRecord): boolean =>
  record.actualTokens === undefined || record.actualTokens > record.reservedTokens

/** Diagnostics counters (§5.8); ids/counts/fingerprints only, never original text or candidate bodies (§5.5.3). */
export type DistillationDiagnostics = Readonly<{
  proposeCalls: number
  judgeCalls: number
  candidateHits: number
  validationHits: number
  projectionsApplied: number
  projectionsUnsent: number
  savedTokensEstimate: number
}>

export const emptyDiagnostics: DistillationDiagnostics = {
  proposeCalls: 0,
  judgeCalls: 0,
  candidateHits: 0,
  validationHits: 0,
  projectionsApplied: 0,
  projectionsUnsent: 0,
  savedTokensEstimate: 0,
}
