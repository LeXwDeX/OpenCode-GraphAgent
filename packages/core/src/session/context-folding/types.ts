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
  | "work-limit"

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

export type OptionalInputLimit = Readonly<{ kind: "absent" }> | Readonly<{ kind: "value"; value: unknown }>

export type SystemTransmission =
  | Readonly<{ kind: "messages" }>
  | Readonly<{ kind: "instructions"; value: unknown }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "unknown" }>

export type PreparedRequestBudgetInput = Readonly<{
  contextLimit: unknown
  inputLimit: OptionalInputLimit
  outputReserve: unknown
  system: SystemTransmission
  messages: unknown
  /** Wire-visible tool names, descriptions, and schemas only; executable closures are never supplied here. */
  tools: unknown
  protocolOverheadTokens: unknown
  media: "none" | "unknown"
}>

export type BudgetSkipReason =
  | "below-target"
  | "invalid-context-limit"
  | "invalid-input-limit"
  | "invalid-output-reserve"
  | "invalid-protocol-overhead"
  | "unknown-content"
  | "unknown-media"
  | "unknown-system"
  | "work-limit"

export type ContextFoldingBudget = Readonly<{
  usableInputTokens: number | undefined
  targetTokens: number | undefined
  estimatedInputTokens: number | undefined
  overBudget: boolean | undefined
  inputBytes: number | undefined
  skipReason: BudgetSkipReason | undefined
}>

export type WirePathSegment = string | number

export type WireCallMapping = Readonly<{
  ref: FoldRef
  visibleCallID: string
  ordinal: number
}>

export type WireResultMapping = Readonly<{
  ref: FoldRef
  visibleCallID: string
  ordinal: number
  bodyPath: readonly WirePathSegment[]
  complete: boolean
}>

/** Adapter-produced view of the final provider-visible request. */
export type WireProjectionSnapshot = Readonly<{
  requestFingerprint: string
  calls: readonly WireCallMapping[]
  results: readonly WireResultMapping[]
}>

export type SelectedFoldReplacement = Readonly<{
  source: FoldRef
  witness: FoldRef
  placeholder: string
  estimatedSavings: number
}>

export type ProjectionSkipReason =
  | BudgetSkipReason
  | PlanSkipReason
  | "already-projected"
  | "insufficient-savings"
  | "invalid-reference"
  | "mapping-mismatch"
  | "projection-failed"
  | "stale-request"

export type ContextFoldingProjectionPlan = Readonly<{
  replacements: readonly SelectedFoldReplacement[]
  estimatedBefore: number | undefined
  estimatedAfter: number | undefined
  targetTokens: number | undefined
  overBudget: boolean | undefined
  skipReason: ProjectionSkipReason | undefined
}>

export type ContextFoldingProjectionInput<Request> = Readonly<{
  request: Request
  /** Serializable model/runtime/system/messages/tools identity captured when the duplicate plan was prepared. */
  identity: unknown
  expectedRequestFingerprint: string
  duplicatePlan: FoldPlan
  budget: PreparedRequestBudgetInput
  mapping: WireProjectionSnapshot
}>

export type ContextFoldingProjectionResult<Request> = Readonly<{
  request: Request
  applied: boolean
  plan: ContextFoldingProjectionPlan
}>

export type ProjectionDependencies = Readonly<{
  /** Test seam for proving that a failure after one or more private-copy writes still returns the original request. */
  afterReplacement?: (replacementIndex: number) => void
}>
