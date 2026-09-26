import { describe, expect, test } from "bun:test"
import corpus from "../fixtures/reasoning-distillation-long-task-corpus.json"
import {
  fingerprintContextFoldingRequest,
  type ContextFoldingBudget,
  type PreparedRequestBudgetInput,
} from "../../src/session/context-folding"
import {
  planReasoningDistillation,
  projectDistillationRequest,
  ReasoningDistillationPolicy,
  type Candidate,
  type Claim,
  type ClaimKind,
  type ClaimSupport,
  type SourceSpan,
  type WireReasoningMapping,
} from "../../src/session/reasoning-distillation"
import { Hash } from "../../src/util/hash"

const claimKinds: ReadonlySet<string> = new Set([
  "fact",
  "constraint",
  "decision",
  "rejection",
  "assumption",
  "state_delta",
])
const isClaimKind = (value: string): value is ClaimKind => claimKinds.has(value)
const count = (text: string, marker: string) => text.split(marker).length - 1

describe(`frozen reasoning-distillation corpus ${corpus.version}`, () => {
  test("preserves approved claims and continuity while rejecting contradicted projections", () => {
    const started = performance.now()
    let accepted = 0
    let expectedClaims = 0
    let retainedClaims = 0
    let repeatedActions = 0
    let actionCount = 0
    let realizedSavedTokens = 0
    let auxiliaryInputTokens = 0
    let auxiliaryOutputTokens = 0

    for (const scenario of corpus.scenarios) {
      const source = scenario.sourcePrefix + scenario.repeatedUnit.repeat(scenario.repeatCount)
      const messageID = `message-${scenario.id}`
      const partID = `reasoning-${scenario.id}`
      const span: SourceSpan = {
        messageID,
        partID,
        start: 0,
        end: source.length,
        fingerprint: Hash.sha256(source),
      }
      const claims: Claim[] = scenario.claims.map((item) => {
        if (!isClaimKind(item.kind)) throw new Error(`invalid frozen claim kind: ${item.kind}`)
        return {
          id: item.id,
          kind: item.kind,
          text: item.text,
          scope: item.scope,
          sources: [span],
          evidence: [{ messageID, partID, kind: "source" }],
          status: "verified",
        }
      })
      const key = {
        sessionID: `session-${scenario.id}`,
        messageID,
        partIDs: [partID],
        sourceFingerprint: span.fingerprint,
        capabilityFingerprint: "frozen-capability-v1",
        organizerFingerprint: "frozen-organizer-v1",
        policyVersion: ReasoningDistillationPolicy.version,
      }
      const candidate: Candidate = {
        key,
        fingerprint: Hash.sha256(JSON.stringify(scenario.claims)),
        claims,
        preserved: [],
        coverage: [{ source: span, action: "keep", claimID: claims[0].id }],
      }
      const support: ClaimSupport[] = claims.map((item) => ({
        claimID: item.id,
        result:
          scenario.supportVerdict === "supported"
            ? { verdict: "supported", method: "deterministic" }
            : { verdict: "contradicted", method: "deterministic" },
      }))
      const mapping: WireReasoningMapping = {
        refs: [{ messageID, partID }],
        shape: "interleaved-field",
        eligibility: { allowed: true, capabilityFingerprint: key.capabilityFingerprint },
        bodyPath: ["messages", 0, "reasoning"],
        sourceFingerprint: span.fingerprint,
      }
      const originalTokens = Math.ceil(source.length / 4)
      const budget: ContextFoldingBudget = {
        usableInputTokens: originalTokens,
        targetTokens: Math.floor(originalTokens / 2),
        estimatedInputTokens: originalTokens,
        overBudget: true,
        inputBytes: new TextEncoder().encode(source).byteLength,
        skipReason: undefined,
      }
      const judgeFingerprint = Hash.sha256(JSON.stringify(support))
      const plan = planReasoningDistillation(
        {
          purpose: "conversation",
          budget,
          candidate,
          evidence: {
            spans: [span],
            calls: [],
            inventoryComplete: true,
            inventoryFingerprint: `inventory-${scenario.id}`,
          },
          mappings: [mapping],
          quota: { proposeUsed: true, judgeUsed: true },
          originalTokens,
          support,
          judgeFingerprint,
          policyVersion: ReasoningDistillationPolicy.version,
        },
        { resolveText: (item) => source.slice(item.start, item.end) },
      )

      expect(plan.replacements.length > 0).toBe(scenario.expectedAccepted)
      if (!scenario.expectedAccepted) {
        expect(plan.skipReason).toBeDefined()
        expect(plan.audit.length).toBeGreaterThan(0)
        continue
      }

      const request = { messages: [{ role: "assistant", reasoning: source }] }
      const identity = { corpus: corpus.version, scenario: scenario.id }
      const preparedBudget: PreparedRequestBudgetInput = {
        contextLimit: originalTokens,
        inputLimit: { kind: "absent" },
        outputReserve: 0,
        system: { kind: "none" },
        messages: request.messages,
        tools: [],
        protocolOverheadTokens: 0,
        media: "none",
      }
      const fingerprint = fingerprintContextFoldingRequest({ request, identity, budget: preparedBudget })
      if (!fingerprint.ok) throw new Error(`failed to fingerprint ${scenario.id}: ${fingerprint.reason}`)
      const projected = projectDistillationRequest({
        request,
        identity,
        expectedRequestFingerprint: fingerprint.value,
        budget: preparedBudget,
        replacements: plan.replacements,
      })
      expect(projected.applied).toBe(true)
      const output = projected.request.messages[0].reasoning
      for (const term of scenario.requiredTerms) expect(output).toContain(term)
      for (const claim of scenario.claims) {
        expectedClaims++
        if (output.includes(claim.text)) retainedClaims++
      }
      for (const action of scenario.actionMarkers) {
        actionCount++
        repeatedActions += Math.max(0, count(output, action) - 1)
      }
      accepted++
      realizedSavedTokens += plan.replacements[0].estimatedSavings * scenario.subsequentSends
      auxiliaryInputTokens += scenario.auxiliaryUsage.inputTokens
      auxiliaryOutputTokens += scenario.auxiliaryUsage.outputTokens
    }

    const latencyMs = performance.now() - started
    const auxiliaryTokens = auxiliaryInputTokens + auxiliaryOutputTokens
    const savedCostUsd =
      (realizedSavedTokens * corpus.pricingBasis.inputUsdPerMillionTokens) / 1_000_000
    const auxiliaryCostUsd =
      (auxiliaryInputTokens * corpus.pricingBasis.inputUsdPerMillionTokens +
        auxiliaryOutputTokens * corpus.pricingBasis.outputUsdPerMillionTokens) /
      1_000_000

    expect(accepted).toBeGreaterThan(0)
    expect(retainedClaims).toBe(expectedClaims)
    expect(actionCount).toBeGreaterThan(0)
    expect(repeatedActions).toBe(0)
    expect(auxiliaryTokens / realizedSavedTokens).toBeLessThan(1)
    expect(savedCostUsd - auxiliaryCostUsd).toBeGreaterThan(0)
    expect(latencyMs).toBeLessThan(1_000)
  })
})
