import type {
  AuditConfidence,
  AuditFinding,
  CallObservation,
  ExecutionMatch,
  ExecutionTarget,
  EvidenceRef,
  ReasoningEvidence,
  SupportResult,
} from "./types"

/**
 * Conservation-audit primitives (§5.5). Pure functions over the host's read-only evidence snapshot. Execution
 * matching is deterministic; semantic support is supplied by the caller as a SupportResult (judge or deterministic
 * predicate). "Fraud" is the product name for a verifiable violation and never infers subjective intent.
 */

const toolMatches = (target: ExecutionTarget, call: CallObservation): boolean => {
  if (call.toolName !== target.toolName) return false
  // Lossless parameter encoding: compare fingerprints only when both sides carry one; never normalize whitespace,
  // quotes, case, or paths here (§5.5.1).
  if (target.inputFingerprint !== undefined && call.inputFingerprint !== undefined) {
    if (target.inputFingerprint !== call.inputFingerprint) return false
  }
  // Scope is matched on the observable message ids; step-level scoping is resolved by the host before this call.
  if (target.scope.messageIDs.length > 0 && !target.scope.messageIDs.includes(call.ref.messageID)) return false
  return true
}

const inScope = (target: ExecutionTarget, call: CallObservation): boolean => toolMatches(target, call)

/**
 * Resolve an execution target against the authoritative call inventory (§5.5.1).
 * - Unsettled scope (in-flight / not yet at the fulfillment boundary) is unknown, never absent (P4 protection).
 * - An incomplete inventory cannot prove absence, so a no-match result stays unknown.
 * - `call` selects one exact callID; a different successful retry never substitutes for it.
 * - `at-least-one` matches any in-scope call; `all` requires a determined finite target set (deferred to unknown).
 * - Multiple indistinguishable candidates are ambiguous, not absent.
 */
export const resolveExecutionMatch = (target: ExecutionTarget, evidence: ReasoningEvidence): ExecutionMatch => {
  if (!target.scope.settled) return { kind: "unknown", reason: "unsettled-scope" }
  if (!evidence.inventoryComplete) return { kind: "unknown", reason: "incomplete-inventory" }

  const selector = target.selector
  if (selector.kind === "all") {
    // A determined finite target set is host-supplied; without it, "all" cannot be decided (§5.5.1).
    return { kind: "unknown", reason: "ambiguous-target" }
  }

  const scoped = evidence.calls.filter((call) => inScope(target, call))

  if (selector.kind === "call") {
    const callID = selector.callID
    const exact = scoped.filter((call) => call.ref.callID === callID)
    if (exact.length === 1) return { kind: "matched", calls: exact }
    if (exact.length === 0) {
      // A specific callID that is not in a complete, settled inventory is absent; an off-scope success never counts.
      return { kind: "absent", inventoryFingerprint: evidence.inventoryFingerprint }
    }
    return { kind: "unknown", reason: "ambiguous-target" }
  }

  // at-least-one
  if (scoped.length === 0) return { kind: "absent", inventoryFingerprint: evidence.inventoryFingerprint }
  return { kind: "matched", calls: scoped }
}

export type ExecutionVerdictInput = Readonly<{
  target: ExecutionTarget
  match: ExecutionMatch
  /** True when the source text honestly reports the actual failure/refusal (§5.5.2 last row). */
  sourceStatesFailure: boolean
  /** Targeted support for the completion claim; judge- or deterministic-produced. */
  support: SupportResult
}>

const isCompleted = (call: CallObservation): boolean => call.status === "completed"
const isSettled = (call: CallObservation): boolean =>
  call.status === "completed" || call.status === "error" || call.status === "interrupted"

/**
 * Whether the matched calls satisfy the target's expectation, per selector (§5.5.1):
 * - "invoked" is satisfied by any matched call.
 * - "succeeded" + a specific call requires that exact call to be completed (a different successful retry never substitutes).
 * - "succeeded" + at-least-one requires some completed call; + all requires every matched call completed.
 * Returns undefined when the matched calls are not yet settled enough to decide.
 */
const expectationSatisfied = (target: ExecutionTarget, calls: readonly CallObservation[]): boolean | undefined => {
  if (target.expectation === "invoked") return calls.length > 0
  if (calls.length === 0) return false
  const selector = target.selector
  if (selector.kind === "call") {
    const callID = selector.callID
    const exact = calls.find((call) => call.ref.callID === callID)
    if (!exact) return undefined
    return isSettled(exact) ? isCompleted(exact) : undefined
  }
  if (selector.kind === "all") {
    if (calls.some((call) => !isSettled(call))) return undefined
    return calls.every(isCompleted)
  }
  // at-least-one: a single completed call satisfies the success requirement.
  if (calls.some(isCompleted)) return true
  if (calls.some((call) => !isSettled(call))) return undefined
  return false
}

/**
 * Exclusive top-down verdict for one execution claim (§5.5.2). Returns undefined when there is no violation.
 * Execution findings are mutually exclusive; fabricated/concealed/evidence_swap come from gate failures elsewhere.
 */
export const resolveExecutionVerdict = (input: ExecutionVerdictInput): AuditFinding | undefined => {
  const { target, match, sourceStatesFailure, support } = input
  const evidenceRefs = (calls: readonly CallObservation[]): EvidenceRef[] => calls.map((call) => ({ ...call.ref }))

  // Row 2: target/scope/match/necessary evidence unknown -> unverifiable only; a judge cannot invent execution records.
  if (match.kind === "unknown") {
    return {
      kind: "unverifiable",
      targetID: target.id,
      evidence: [],
      confidence: "unverifiable",
      reasonCode: `execution-unknown:${match.reason}`,
    }
  }

  // Row 3: absent + an explicit tool claim, or an unfulfilled clear requirement at a settled boundary -> simulated.
  if (match.kind === "absent") {
    const claimedOrDue = target.modality === "reported" || (target.modality === "required" && target.scope.settled)
    if (claimedOrDue) {
      return {
        kind: "simulated_execution",
        targetID: target.id,
        claimID: target.claimID,
        evidence: [],
        confidence: "deterministic",
        reasonCode: "execution-absent",
      }
    }
    return {
      kind: "unverifiable",
      targetID: target.id,
      evidence: [],
      confidence: "unverifiable",
      reasonCode: "execution-absent-not-due",
    }
  }

  // matched
  // Row 6 (partial): the source honestly states the actual failure -> no violation; failure and refusal stay preserved.
  if (sourceStatesFailure) return undefined

  const calls = match.calls
  const satisfied = expectationSatisfied(target, calls)

  // Row 5 (unsettled): matched but in-flight, so completion can be neither supported nor refuted yet.
  if (satisfied === undefined) {
    return {
      kind: "unverifiable",
      targetID: target.id,
      claimID: target.claimID,
      evidence: evidenceRefs(calls),
      confidence: "unverifiable",
      reasonCode: "matched-call-unsettled",
    }
  }

  // Row 4: the source claims a successful settlement but the expectation is not met, or targeted evidence contradicts
  // the specific completion claim -> unbacked_completion (never "never called", never refuting all side effects).
  if (!satisfied || support.verdict === "contradicted") {
    const confidence: AuditConfidence =
      satisfied && support.verdict === "contradicted" ? support.method : "deterministic"
    return {
      kind: "unbacked_completion",
      targetID: target.id,
      claimID: target.claimID,
      evidence: evidenceRefs(calls),
      confidence,
      reasonCode: satisfied ? "completion-contradicted" : "expected-success-not-met",
    }
  }

  // Row 5: expectation met but targeted support is unknown (e.g. truncated/cleaned body) -> unverifiable only.
  if (support.verdict === "unknown") {
    return {
      kind: "unverifiable",
      targetID: target.id,
      claimID: target.claimID,
      evidence: evidenceRefs(calls),
      confidence: "unverifiable",
      reasonCode: `support-unknown:${support.reasonCode}`,
    }
  }

  // Row 6: matched + targeted support -> no violation.
  return undefined
}
