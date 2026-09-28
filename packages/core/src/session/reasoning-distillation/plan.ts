import { Hash } from "../../util/hash"
import { assembleAudit, gateViolationToFinding, resolveExecutionMatch, resolveExecutionVerdict } from "./audit"
import { evaluateGates } from "./gates"
import { ReasoningDistillationPolicy } from "./policy"
import type {
  AuditFinding,
  AuditRecord,
  Claim,
  DistillationDependencies,
  DistillationKey,
  DistillationPlan,
  DistillationPlanInput,
  DistillationSkipReason,
  ModelProjection,
  SourceSpan,
  ValidationStamp,
  WireReasoningMapping,
} from "./types"

/**
 * Pure planning orchestrator (§5.2). Consumes host observations, support verdicts, and optional execution targets;
 * performs no I/O and never disguises LLM extraction as deterministic parsing. The result is three-way:
 * - applied:   replacements non-empty, extraCall "none",   skipReason undefined
 * - deferred:  replacements empty,     extraCall != "none", skipReason undefined (host makes the call, then re-plans)
 * - skipped:   replacements empty,     extraCall "none",   skipReason set (terminal; send the original)
 *
 * Gate evaluation (§5.4) and the conservation audit (§5.5) run on every present candidate, and the audit is recorded
 * even when the candidate is rejected, so a fidelity failure never swallows fabricated/concealed/evidence_swap or
 * source-agent execution findings. Judge/propose model orchestration is the host's job (Phase 3b/2 runtime).
 */

const emptyPlan = (skipReason: DistillationSkipReason, audit: readonly AuditRecord[] = []): DistillationPlan => ({
  replacements: [],
  audit,
  reusedCandidates: [],
  extraCall: "none",
  skipReason,
})

const deferredPlan = (extraCall: "propose" | "judge", audit: readonly AuditRecord[] = []): DistillationPlan => ({
  replacements: [],
  audit,
  reusedCandidates: [],
  extraCall,
  skipReason: undefined,
})

const allowedPurposes = new Set<string>(ReasoningDistillationPolicy.allowedPurposes)

/** Conservative character proxy; the real tokenizer is supplied by the runtime adapter in Phase 2. */
const defaultEstimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** Shared organizer contract for the overlap and self-witness failures observed in release acceptance. */
export const COVERAGE_CONTRACT = `来源编号由程序绑定到原文的精确范围；sources、preserved、coverage.source 和 merge.witness 只引用 R 列出的编号，不生成字符偏移。
coverage 必须将 R 的每个来源编号恰好覆盖一次，不重复、不遗漏。每段只选一种动作：
- keep：用 claimID 指向 sources 包含该段的 claim；该段不再放入 preserved。
- preserve：原文保留；coverage 的 preserve 段与 preserved 数组逐项一一对应，边界相同。全部提炼为 claims 时 preserved 为 []，不能把它当作原文备份。
- merge：witness 是另一个来源编号；那一段必须已有 keep 或 preserve 项。禁止指向自身或其他 merge/drop 项。
- drop：必须给出具体 reason；无价值噪声可丢弃，不能丢弃影响后续判断的信息。全部来源都是噪声时允许 claims=[]、preserved=[]，每段 coverage 均为 drop。
claims 的 text/scope 只陈述 R 中的命题及适用范围，不加入整理器自身的权限或动作说明。`

export const DENOISING_CONTRACT = `按语义去噪并合并重复命题，动态输出 0 到 N 条有用信息，不凑数量、不凑类别或栏目。最终文本只写仍有效且对未来行动有用的命题。已被明确纠正的猜测、误读和自我纠错过程连同其旧数值、旧选项及“旧猜测未执行”等附属否定一并删除；不要在最终结论后补述“先前误以为……”；这类旧内容可用带具体原因的 coverage drop 覆盖，不需要旧 claim 或 supersedes。保留有未来决策价值的最终约束、数值、否定、真实失败原因、回滚、未决不确定性和真实状态变化。不要把认知纠错误当成环境或执行状态变化；真实尝试、失败、回滚及其原因仍需保留。不同 scope 的命题不可混并；暂时性推测不得写成已验证事实。仅在旧判断本身仍对后续理解有意义时保留旧 claim 并使用 supersedes。中文原文可改写以去重，技术标识符必须逐字保留。`

export const REVIEW_RETENTION_CONTRACT = `独立对照完整 R 与最终发送文本，以未来行动所需的语义是否保留及去噪目标是否达到为准。允许删除重复、填充和已放弃的无价值推测，包括所有来源均为噪声而最终发送文本为空；若最终文本仍复述明确失效的猜测、旧数值、自我纠错或“旧猜测未执行”等附属否定，即使最终结论也正确，也判 retention contradicted。只有旧判断本身仍对未来行动有用时才保留取代关系。最终有效的约束、数值、否定、失败/回滚原因、未决不确定性、scope 和真实状态变化不可遗漏或改义；不能把真实失败/回滚当作纯认知噪声。只检查 claims 的逐条支持不足以判定整体保留；不能用 coverage 的 drop reason 代替独立核验。`

export const ORGANIZER_OUTPUT_FORMAT = `格式示例（只示意格式，不要求产出一条或任何固定类别；来源编号必须来自当前 R）：{"claims":[{"id":"c1","kind":"decision","text":"...","scope":"...","sources":["R0.0"],"evidence":[],"status":"unverified"}],"preserved":[],"coverage":[{"source":"R0.0","action":"keep","claimID":"c1"}]}。kind 取 fact/constraint/decision/rejection/assumption/state_delta；status 取 verified/unverified/assumed；supersedes 仅引用仍有意义且被真实取代的旧 claim ID。`

/** Exact UTF-16 ranges include separators so coverage can be checked without model-counted offsets. */
const sourceRanges = (text: string, slotIndex: number) => {
  let start = 0
  return [...text.matchAll(/[^\n]*\n|[^\n]+$/g)].map(([value], index) => {
    const range = { id: `R${slotIndex}.${index}`, start, end: start + value.length, text: value }
    start = range.end
    return range
  })
}

export const renderSourceRanges = (text: string, slotIndex = 0): string => JSON.stringify(sourceRanges(text, slotIndex))

/** Resolve only host-issued aliases; downstream parsers and fidelity gates still validate every bound span. */
export const bindSourceAliases = (
  raw: unknown,
  slots: readonly { messageID: string; partID: string; text: string }[],
): unknown => {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
  if (!record(raw)) return raw
  const aliases = new Map(
    slots.flatMap((slot, slotIndex) =>
      sourceRanges(slot.text, slotIndex).map(
        (range) =>
          [range.id, { messageID: slot.messageID, partID: slot.partID, start: range.start, end: range.end }] as const,
      ),
    ),
  )
  const resolve = (value: unknown) => (typeof value === "string" ? aliases.get(value) : value)
  return {
    ...raw,
    claims: Array.isArray(raw.claims)
      ? raw.claims.map((claim) =>
          record(claim) && Array.isArray(claim.sources) ? { ...claim, sources: claim.sources.map(resolve) } : claim,
        )
      : raw.claims,
    preserved: Array.isArray(raw.preserved) ? raw.preserved.map(resolve) : raw.preserved,
    coverage: Array.isArray(raw.coverage)
      ? raw.coverage.map((entry) =>
          record(entry)
            ? {
                ...entry,
                source: resolve(entry.source),
                ...(entry.action === "merge" ? { witness: resolve(entry.witness) } : {}),
              }
            : entry,
        )
      : raw.coverage,
  }
}

/** Render useful content, keeping scope and uncertainty while hiding schema IDs. */
export const renderDistillation = (
  claims: readonly Claim[],
  preserved: readonly SourceSpan[],
  resolveText: (span: SourceSpan) => string,
): string => {
  const kinds = {
    fact: "事实",
    constraint: "约束",
    decision: "决定",
    rejection: "否决",
    assumption: "假设",
    state_delta: "状态变化",
  }
  const statuses = { verified: "", unverified: "未核验", assumed: "暂作假设" }
  const byID = new Map(claims.map((claim) => [claim.id, claim]))
  const superseded = new Set(claims.map((claim) => claim.supersedes).filter((id): id is string => !!id))
  const claimLines = claims.map((claim) => {
    const prior = claim.supersedes ? byID.get(claim.supersedes) : undefined
    const detail = [
      `适用：${claim.scope}`,
      statuses[claim.status],
      superseded.has(claim.id) ? "已被后续判断取代" : "",
      prior ? `取代此前判断“${prior.text}”` : "",
    ].filter(Boolean)
    return `- ${kinds[claim.kind]}：${claim.text}（${detail.join("；")}）`
  })
  const preservedLines = preserved.map((span) => resolveText(span)).filter((text) => text.length > 0)
  return [...claimLines, ...preservedLines].join("\n")
}

const capabilityOf = (mapping: WireReasoningMapping): string | undefined =>
  mapping.eligibility.allowed ? mapping.eligibility.capabilityFingerprint : undefined

/** Resolve and verdict each host-supplied execution target (§5.5); findings attribute to the source agent. */
const auditExecutionTargets = (input: DistillationPlanInput): AuditFinding[] => {
  const targets = input.targets ?? []
  if (targets.length === 0) return []
  const contextByTarget = new Map((input.executionContext ?? []).map((entry) => [entry.targetID, entry]))
  const findings: AuditFinding[] = []
  for (const target of targets) {
    const match = resolveExecutionMatch(target, input.evidence)
    const context = contextByTarget.get(target.id)
    const finding = resolveExecutionVerdict({
      target,
      match,
      sourceStatesFailure: context?.sourceStatesFailure ?? false,
      support: context?.support ?? { verdict: "unknown", reasonCode: "no-verdict-context" },
    })
    if (finding) findings.push(finding)
  }
  return findings
}

const plan = (input: DistillationPlanInput, dependencies: DistillationDependencies): DistillationPlan => {
  // 1. Purpose gating (§5.1): auxiliary/unknown never sample, call, or apply cache.
  if (!allowedPurposes.has(input.purpose)) return emptyPlan("no-rewritable-slot")

  // Scheduled preparation and validated replay do not depend on approaching the context limit.
  // Unknown/invalid budgets remain protected; a schedule is not permission to bypass validation.
  if (input.trigger === "idle") return emptyPlan("cadence-not-due")
  if (input.budget.overBudget === undefined) return emptyPlan("unknown-content")
  if (input.trigger === undefined && input.budget.overBudget !== true) return emptyPlan("below-target")

  // 3. Slot eligibility (§2/§5.1): need at least one authorized rewritable reasoning slot.
  const eligible = input.mappings.filter((mapping) => mapping.eligibility.allowed)
  if (eligible.length === 0) {
    const compatibilityBlocked = input.mappings.some(
      (mapping) => !mapping.eligibility.allowed && mapping.eligibility.protection === "P5",
    )
    return emptyPlan(compatibilityBlocked ? "compatibility-unproven" : "no-rewritable-slot")
  }

  // 4. Candidate availability (§5.2 step 3): no cached candidate requests one propose call, bounded by quota.
  const candidate = input.candidate
  if (!candidate) {
    if (input.quota.proposeUsed) return emptyPlan("call-budget-exhausted")
    return deferredPlan("propose")
  }

  // 5. Policy/version binding: a candidate stamped under a different policy is stale.
  if (candidate.key.policyVersion !== input.policyVersion) return emptyPlan("stale-validation")

  // 6. Gates G1-G4 (§5.4) + conservation audit (§5.5). Diagnostics are assembled before any rejection so a fidelity
  //    failure never hides fabricated/concealed/evidence_swap or source-agent execution findings (§5.2 step 4).
  const gates = evaluateGates(candidate, input.evidence, input.support, {
    resolveText: dependencies.resolveText,
    retentionSupport: input.retentionSupport,
  })
  const distillerFindings = gates.violations.map(gateViolationToFinding)
  const executionFindings = auditExecutionTargets(input)
  const audit = assembleAudit(executionFindings, distillerFindings)

  // One candidate is bound to one source slot. A second eligible slot needs its own candidate and audit.
  if (eligible.length !== 1) return emptyPlan("mapping-mismatch", audit)

  const mapping = eligible[0]
  const mappedRef = mapping.refs[0]
  if (
    mapping.refs.length !== 1 ||
    candidate.key.partIDs.length !== 1 ||
    candidate.key.messageID !== mappedRef?.messageID ||
    candidate.key.partIDs[0] !== mappedRef.partID ||
    candidate.key.sourceFingerprint !== mapping.sourceFingerprint ||
    candidate.key.capabilityFingerprint !== capabilityOf(mapping)
  ) {
    return emptyPlan("mapping-mismatch", audit)
  }

  // 7. Terminal structural failure -> reject the candidate but keep the diagnostics.
  if (gates.skipReason) return emptyPlan(gates.skipReason, audit)

  // 8. Semantic review still required -> defer to one judge call when quota remains; otherwise send the original and
  //    retry on the next legal trigger (§5.2 step 5).
  if (gates.needsSemanticReview) {
    if (input.quota.judgeUsed) return emptyPlan("semantic-review-required", audit)
    return deferredPlan("judge", audit)
  }
  if (gates.anyJudged && input.judgeFingerprint === undefined) return emptyPlan("stale-validation", audit)

  // 9. Render the projection from validated claims and preserved spans only (§5.5.3 isolation).
  const sourceResolver = dependencies.resolveText
  if (candidate.preserved.length > 0 && !sourceResolver) return emptyPlan("unknown-content", audit)
  const preservedText = new Map<SourceSpan, string>()
  for (const span of candidate.preserved) {
    const original = sourceResolver?.(span)
    if (typeof original !== "string" || original.length === 0) return emptyPlan("unknown-content", audit)
    preservedText.set(span, original)
  }
  const resolveText = (span: SourceSpan): string => preservedText.get(span) ?? ""
  const render = dependencies.render ?? renderDistillation
  const estimateTokens = dependencies.estimateTokens ?? defaultEstimateTokens
  const fingerprint = dependencies.fingerprint ?? Hash.sha256
  const text = render(candidate.claims, candidate.preserved, resolveText)

  // Capacity-triggered compression requires savings; scheduled organization may grow within the request limit.
  if (input.originalTokens === undefined || !Number.isSafeInteger(input.originalTokens)) {
    return emptyPlan("unknown-content", audit)
  }
  const estimatedSavings = input.originalTokens - estimateTokens(text)
  if (input.trigger === undefined && estimatedSavings < ReasoningDistillationPolicy.tokens.minimumNetSavingsTokens) {
    return emptyPlan("insufficient-net-savings", audit)
  }

  // 11. Assemble the replacement for the candidate's exact source slot.
  const projection: ModelProjection = { claims: candidate.claims, preserved: candidate.preserved, text }
  const reusedCandidates: DistillationKey[] = [candidate.key]
  const validation: ValidationStamp = {
    candidateFingerprint: fingerprint(candidate.fingerprint),
    evidenceFingerprint: input.evidence.inventoryFingerprint,
    capabilityFingerprint: candidate.key.capabilityFingerprint,
    validatorVersion: ReasoningDistillationPolicy.validatorVersion,
    method: gates.anyJudged ? "judged" : "deterministic",
    ...(gates.anyJudged ? { judgeFingerprint: input.judgeFingerprint! } : {}),
  }
  const replacements = [{ mapping, projection, validation, estimatedSavings }]

  return { replacements, audit, reusedCandidates, extraCall: "none", skipReason: undefined }
}

export const planReasoningDistillation = (
  input: DistillationPlanInput,
  dependencies: DistillationDependencies = {},
): DistillationPlan => {
  try {
    return plan(input, dependencies)
  } catch {
    return emptyPlan("projection-failed")
  }
}
