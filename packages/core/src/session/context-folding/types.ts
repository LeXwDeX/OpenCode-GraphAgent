export type FoldRef = Readonly<{
  messageID: string
  partID: string
  callID: string
}>

export type ToolSourceKind = "host-builtin" | "custom" | "mcp" | "provider" | "unknown"

export type ToolSourceIdentity = Readonly<{
  sessionID: string
  assistantMessageID: string
  callID: string
  toolName: string
  sourceKind: ToolSourceKind
  registrationID: string
  registrationGeneration: string
}>

export type ToolStatus = "completed" | "pending" | "running" | "error" | "interrupted" | "unknown"

export type CandidateResult =
  | Readonly<{
      kind: "text"
      text: string
      complete: boolean
      /** Adapter-validated, non-body result fields that must also match exactly (for example Core TextPage fields). */
      comparisonMetadata?: unknown
    }>
  | Readonly<{
      kind: "unknown"
    }>

export type CandidateSafety = Readonly<{
  attachments: "none" | "present" | "unknown"
  instructions: "none" | "dynamic" | "unknown"
  providerExecuted: false | true | "unknown"
}>

export type FoldCandidate = Readonly<{
  ref: FoldRef
  toolName: string
  source: ToolSourceIdentity
  status: ToolStatus
  input: unknown
  result: CandidateResult
  safety: CandidateSafety
  /** Required for read candidates so instruction-file basenames remain protected. */
  targetPath?: string
}>

export type FoldStep = Readonly<{
  id: string
  /** Estimate for the complete step, including non-candidate content and protocol overhead. */
  estimatedTokens: number
  candidates: readonly FoldCandidate[]
}>

export type CandidateSkipReason =
  | "attachments"
  | "incomplete-content"
  | "instruction-content"
  | "invalid-provenance"
  | "normalization-failed"
  | "provider-executed"
  | "unknown-content"
  | "unknown-read-target"
  | "unsuccessful"
  | "unsupported-tool"
  | "untrusted-source"

export type PlanSkipReason =
  | "all-sources-protected"
  | "fingerprint-failed"
  | "invalid-structure"
  | "no-eligible-duplicates"
  | "unknown-step-tokens"

export type FoldReplacement = Readonly<{
  source: FoldRef
  witness: FoldRef
}>

export type CandidateExclusion = Readonly<{
  ref: FoldRef
  reason: CandidateSkipReason
}>

export type FoldPlan = Readonly<{
  replacements: readonly FoldReplacement[]
  protectedStepIDs: readonly string[]
  exclusions: readonly CandidateExclusion[]
  skipReason: PlanSkipReason | undefined
}>

export type PlannerDependencies = Readonly<{
  /** Internal seam used to prove that fingerprint collisions still receive a full equality check. */
  fingerprint?: (value: string) => string
}>
