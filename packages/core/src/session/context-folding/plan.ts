import { Hash } from "../../util/hash"
import { normalizeParameters, type NormalizedParameters } from "./normalize"
import { ContextFoldingPolicy } from "./policy"
import type {
  CandidateExclusion,
  CandidateResult,
  CandidateSkipReason,
  FoldCandidate,
  FoldPlan,
  FoldRef,
  FoldReplacement,
  FoldStep,
  PlannerDependencies,
  PlanSkipReason,
} from "./types"

type PreparedCandidate = Readonly<{
  candidate: FoldCandidate
  normalizedInput: string
  normalizedResultMetadata: string
  sequence: number
  stepIndex: number
}>

const allowedTools = new Set<string>(ContextFoldingPolicy.allowedTools)
const protectedInstructionBasenames = new Set<string>(ContextFoldingPolicy.protectedInstructionBasenames)

const copyRef = (ref: FoldRef): FoldRef => ({
  messageID: ref.messageID,
  partID: ref.partID,
  callID: ref.callID,
})

const emptyPlan = (
  skipReason: PlanSkipReason,
  protectedStepIDs: readonly string[] = [],
  exclusions: readonly CandidateExclusion[] = [],
): FoldPlan => ({
  replacements: [],
  protectedStepIDs: [...protectedStepIDs],
  exclusions: [...exclusions],
  skipReason,
})

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0
const exactlyTrue = (value: unknown): value is true => value === true

const normalizeComparisonMetadata = (result: CandidateResult): NormalizedParameters => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(result, "comparisonMetadata")
    if (!descriptor) return { ok: true, value: "absent;" }
    if (!("value" in descriptor)) return { ok: false }
    const normalized = normalizeParameters(descriptor.value)
    if (!normalized.ok) return normalized
    return { ok: true, value: `present:${normalized.value}` }
  } catch {
    return { ok: false }
  }
}

const refKey = (ref: FoldRef) => JSON.stringify([ref.messageID, ref.partID, ref.callID])

const stepIDsOrEmpty = (steps: readonly FoldStep[]): readonly string[] => {
  try {
    return steps.map((step) => step.id)
  } catch {
    return []
  }
}

const validateStructure = (steps: readonly FoldStep[]): PlanSkipReason | undefined => {
  if (!Array.isArray(steps)) return "invalid-structure"

  const stepIDs = new Set<string>()
  const refs = new Set<string>()

  try {
    for (const step of steps) {
      if (!nonEmpty(step.id) || stepIDs.has(step.id) || !Array.isArray(step.candidates)) return "invalid-structure"
      stepIDs.add(step.id)

      if (!Number.isSafeInteger(step.estimatedTokens) || step.estimatedTokens < 0) return "unknown-step-tokens"

      for (const candidate of step.candidates) {
        if (
          !candidate ||
          !candidate.ref ||
          !nonEmpty(candidate.ref.messageID) ||
          !nonEmpty(candidate.ref.partID) ||
          !nonEmpty(candidate.ref.callID)
        ) {
          return "invalid-structure"
        }
        const key = refKey(candidate.ref)
        if (refs.has(key)) return "invalid-structure"
        refs.add(key)
      }
    }
  } catch {
    return "invalid-structure"
  }

  return undefined
}

const recentProtection = (steps: readonly FoldStep[]): ReadonlySet<number> | undefined => {
  const protectedIndexes = new Set<number>()
  let protectedTokens = 0
  let protectedSteps = 0

  for (
    let index = steps.length - 1;
    index >= 0 &&
    (protectedSteps < ContextFoldingPolicy.protectRecentSteps ||
      protectedTokens < ContextFoldingPolicy.protectRecentTokens);
    index--
  ) {
    const tokens = steps[index].estimatedTokens
    if (!Number.isSafeInteger(protectedTokens + tokens)) return undefined
    protectedTokens += tokens
    protectedSteps++
    protectedIndexes.add(index)
  }

  return protectedIndexes
}

const readTargetIsProtected = (candidate: FoldCandidate): boolean | undefined => {
  if (candidate.toolName !== "read") return false
  if (!nonEmpty(candidate.targetPath)) return undefined
  const basename = candidate.targetPath.split(/[\\/]/).at(-1)?.toLowerCase()
  if (!basename) return undefined
  return protectedInstructionBasenames.has(basename)
}

const exclusionReason = (candidate: FoldCandidate): CandidateSkipReason | undefined => {
  try {
    if (!allowedTools.has(candidate.toolName)) return "unsupported-tool"
    if (candidate.source.sourceKind !== "host-builtin") return "untrusted-source"
    if (
      !nonEmpty(candidate.source.sessionID) ||
      candidate.source.assistantMessageID !== candidate.ref.messageID ||
      candidate.source.callID !== candidate.ref.callID ||
      candidate.source.toolName !== candidate.toolName ||
      !nonEmpty(candidate.source.registrationID) ||
      !nonEmpty(candidate.source.registrationGeneration)
    ) {
      return "invalid-provenance"
    }
    if (candidate.status !== "completed") return "unsuccessful"
    if (candidate.safety.attachments !== "none") return "attachments"
    if (candidate.safety.instructions !== "none") return "instruction-content"
    if (candidate.safety.providerExecuted !== false) return "provider-executed"

    const protectedTarget = readTargetIsProtected(candidate)
    if (protectedTarget === undefined) return "unknown-read-target"
    if (protectedTarget) return "instruction-content"

    if (candidate.result.kind !== "text" || typeof candidate.result.text !== "string") return "unknown-content"
    if (!exactlyTrue(candidate.result.complete)) return "incomplete-content"
  } catch {
    return "unknown-content"
  }

  return undefined
}

const exactIdentity = (prepared: PreparedCandidate): string => {
  const { candidate, normalizedInput, normalizedResultMetadata } = prepared
  if (candidate.result.kind !== "text") throw new Error("prepared candidate must contain text")
  return JSON.stringify([
    candidate.toolName,
    candidate.source.sessionID,
    candidate.source.sourceKind,
    candidate.source.registrationID,
    candidate.source.registrationGeneration,
    normalizedInput,
    normalizedResultMetadata,
    candidate.result.text,
  ])
}

/**
 * Finds safe duplicate relationships without applying them. The caller remains responsible for S03 budget selection,
 * placeholder construction, mapping validation, and atomic request projection.
 */
export const planContextFolding = (steps: readonly FoldStep[], dependencies: PlannerDependencies = {}): FoldPlan => {
  const structureError = validateStructure(steps)
  if (structureError) {
    const protectedStepIDs = structureError === "unknown-step-tokens" ? stepIDsOrEmpty(steps) : []
    return emptyPlan(structureError, protectedStepIDs)
  }

  const protectedIndexes = recentProtection(steps)
  if (!protectedIndexes) return emptyPlan("unknown-step-tokens", stepIDsOrEmpty(steps))
  const protectedStepIDs = [...protectedIndexes].sort((a, b) => a - b).map((index) => steps[index].id)

  const exclusions: CandidateExclusion[] = []
  const prepared: PreparedCandidate[] = []
  let sequence = 0

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    for (const candidate of steps[stepIndex].candidates) {
      const reason = exclusionReason(candidate)
      if (reason) {
        exclusions.push({ ref: copyRef(candidate.ref), reason })
        sequence++
        continue
      }

      let normalizedInput: NormalizedParameters
      let normalizedResultMetadata: NormalizedParameters
      try {
        normalizedInput = normalizeParameters(candidate.input)
        normalizedResultMetadata = normalizeComparisonMetadata(candidate.result)
      } catch {
        normalizedInput = { ok: false }
        normalizedResultMetadata = { ok: false }
      }
      if (!normalizedInput.ok || !normalizedResultMetadata.ok) {
        exclusions.push({ ref: copyRef(candidate.ref), reason: "normalization-failed" })
        sequence++
        continue
      }

      prepared.push({
        candidate,
        normalizedInput: normalizedInput.value,
        normalizedResultMetadata: normalizedResultMetadata.value,
        sequence,
        stepIndex,
      })
      sequence++
    }
  }

  const fingerprint = dependencies.fingerprint ?? Hash.sha256
  const buckets = new Map<string, Map<string, PreparedCandidate[]>>()

  try {
    for (const item of prepared) {
      // The fingerprint only narrows the bucket. The complete identity string (including the full body) is compared next.
      const identity = exactIdentity(item)
      const hash = fingerprint(identity)
      const bucket = buckets.get(hash) ?? new Map<string, PreparedCandidate[]>()
      const group = bucket.get(identity) ?? []
      group.push(item)
      bucket.set(identity, group)
      buckets.set(hash, bucket)
    }
  } catch {
    return emptyPlan("fingerprint-failed", protectedStepIDs, exclusions)
  }

  const replacements: Array<FoldReplacement & { readonly sequence: number }> = []
  let duplicateGroups = 0

  for (const bucket of buckets.values()) {
    for (const group of bucket.values()) {
      if (group.length < 2) continue
      duplicateGroups++
      const witness = group.at(-1)!

      for (const source of group.slice(0, -1)) {
        if (protectedIndexes.has(source.stepIndex)) continue
        replacements.push({
          source: copyRef(source.candidate.ref),
          witness: copyRef(witness.candidate.ref),
          sequence: source.sequence,
        })
      }
    }
  }

  replacements.sort((a, b) => a.sequence - b.sequence)
  if (replacements.length === 0) {
    return emptyPlan(
      duplicateGroups > 0 ? "all-sources-protected" : "no-eligible-duplicates",
      protectedStepIDs,
      exclusions,
    )
  }

  return {
    replacements: replacements.map(({ source, witness }) => ({ source, witness })),
    protectedStepIDs,
    exclusions,
    skipReason: undefined,
  }
}
