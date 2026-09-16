import { describe, expect, test } from "bun:test"
import {
  ContextFoldingPolicy,
  estimateContextFoldingBudget,
  fingerprintContextFoldingRequest,
  normalizeParameters,
  planContextFolding,
  projectContextFoldingRequest,
  type ContextFoldingProjectionInput,
  type BudgetSkipReason,
  type FoldCandidate,
  type FoldPlan,
  type FoldRef,
  type FoldStep,
  type PreparedRequestBudgetInput,
  type WireProjectionSnapshot,
} from "../../src/session/context-folding"
import { Token } from "../../src/util/token"

const ref = (id: string): FoldRef => ({ messageID: `message-${id}`, partID: `part-${id}`, callID: `call-${id}` })

const duplicatePlan = (source: FoldRef, witness: FoldRef): FoldPlan => ({
  replacements: [{ source, witness }],
  protectedStepIDs: [],
  exclusions: [],
  skipReason: undefined,
})

const emptyDuplicatePlan: FoldPlan = {
  replacements: [],
  protectedStepIDs: [],
  exclusions: [],
  skipReason: "no-eligible-duplicates",
}

const budgetInput = (
  messages: unknown,
  overrides: Partial<PreparedRequestBudgetInput> = {},
): PreparedRequestBudgetInput => ({
  contextLimit: 1_000,
  inputLimit: { kind: "absent" },
  outputReserve: 100,
  system: { kind: "none" },
  messages,
  tools: [],
  protocolOverheadTokens: 0,
  media: "none",
  ...overrides,
})

type WireRequest = {
  messages: Array<{ role: string; callID: string; body?: string; nested?: { mutable: string } }>
  metadata: { mutable: string }
}

const projectionFixture = (body: string, sourceCallID = "visible-source", witnessCallID = "visible-witness") => {
  const source = ref("source")
  const witness = ref("witness")
  const request: WireRequest = {
    messages: [
      { role: "assistant", callID: sourceCallID },
      { role: "tool", callID: sourceCallID, body },
      { role: "assistant", callID: witnessCallID },
      { role: "tool", callID: witnessCallID, body },
    ],
    metadata: { mutable: "original" },
  }
  const identity = { model: "test-model", runtime: "test-runtime", request, tools: [] }
  const fingerprint = fingerprintContextFoldingRequest(identity)
  if (!fingerprint.ok) throw new Error(`fixture fingerprint failed: ${fingerprint.reason}`)
  const mapping: WireProjectionSnapshot = {
    requestFingerprint: fingerprint.value,
    calls: [
      { ref: source, visibleCallID: sourceCallID, ordinal: 0 },
      { ref: witness, visibleCallID: witnessCallID, ordinal: 1 },
    ],
    results: [
      { ref: source, visibleCallID: sourceCallID, ordinal: 0, bodyPath: ["messages", 1, "body"], complete: true },
      { ref: witness, visibleCallID: witnessCallID, ordinal: 1, bodyPath: ["messages", 3, "body"], complete: true },
    ],
  }
  const input: ContextFoldingProjectionInput<WireRequest> = {
    request,
    identity,
    expectedRequestFingerprint: fingerprint.value,
    duplicatePlan: duplicatePlan(source, witness),
    budget: budgetInput(request.messages),
    mapping,
  }
  return { input, source, witness }
}

const expectedPlaceholder = (callID: string) =>
  `[Duplicate tool output folded. Identical full output is retained in later tool call ${JSON.stringify(callID)}.]`

const bodyForSavings = (savings: number, callID = "visible-witness") => {
  const placeholderTokens = Token.estimate(JSON.stringify(expectedPlaceholder(callID)))
  for (let length = Math.max(0, (savings + placeholderTokens) * 4 - 16); length < 20_000; length++) {
    const body = "x".repeat(length)
    if (Token.estimate(JSON.stringify(body)) - placeholderTokens === savings) return body
  }
  throw new Error(`could not build body for ${savings} tokens of savings`)
}

const deepFreeze = (value: unknown, seen = new Set<object>()): void => {
  if (!value || typeof value !== "object" || seen.has(value)) return
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  Object.freeze(value)
}

describe("context folding budget", () => {
  test("computes U=min(I,C-O), T=floor(U*0.7), and counts each actual system location once", () => {
    const system = "system".repeat(600)
    const inMessages = estimateContextFoldingBudget(
      budgetInput([{ role: "system", content: system }], {
        contextLimit: 10_000,
        inputLimit: { kind: "value", value: 8_000 },
        outputReserve: 1_000,
        system: { kind: "messages" },
      }),
    )
    const inInstructions = estimateContextFoldingBudget(
      budgetInput([], {
        contextLimit: 10_000,
        inputLimit: { kind: "value", value: 8_000 },
        outputReserve: 1_000,
        system: { kind: "instructions", value: system },
      }),
    )
    const noSystem = estimateContextFoldingBudget(
      budgetInput([], {
        contextLimit: 10_000,
        inputLimit: { kind: "value", value: 8_000 },
        outputReserve: 1_000,
      }),
    )

    expect(inMessages).toMatchObject({ usableInputTokens: 8_000, targetTokens: 5_600 })
    expect(inInstructions).toMatchObject({ usableInputTokens: 8_000, targetTokens: 5_600 })
    expect(inMessages.estimatedInputTokens!).toBeGreaterThan(noSystem.estimatedInputTokens!)
    expect(inInstructions.estimatedInputTokens!).toBeGreaterThan(noSystem.estimatedInputTokens!)

    const largeUsableInput = 2_847_580_569_751_480
    expect(
      estimateContextFoldingBudget(budgetInput([], { contextLimit: largeUsableInput + 1, outputReserve: 1 }))
        .targetTokens,
    ).toBe(1_993_306_398_826_036)
  })

  test("plans only above the soft target, not below or equal", () => {
    const baseInput = budgetInput([], { contextLimit: 100_000, outputReserve: 10_000 })
    const base = estimateContextFoldingBudget(baseInput)
    expect(base.estimatedInputTokens).toBeDefined()
    const target = base.targetTokens!
    const equal = estimateContextFoldingBudget({
      ...baseInput,
      protocolOverheadTokens: target - base.estimatedInputTokens!,
    })
    const above = estimateContextFoldingBudget({
      ...baseInput,
      protocolOverheadTokens: target - base.estimatedInputTokens! + 1,
    })

    expect(equal).toMatchObject({ estimatedInputTokens: target, overBudget: false, skipReason: "below-target" })
    expect(above).toMatchObject({ estimatedInputTokens: target + 1, overBudget: true, skipReason: undefined })
  })

  test("fails closed for explicit invalid limits, unknown output reserve, media, and unserializable tools", () => {
    const cases: Array<[Partial<PreparedRequestBudgetInput>, BudgetSkipReason]> = [
      [{ contextLimit: 0 }, "invalid-context-limit"],
      [{ inputLimit: { kind: "value", value: Number.NaN } }, "invalid-input-limit"],
      [{ outputReserve: undefined }, "invalid-output-reserve"],
      [{ outputReserve: 1_000 }, "invalid-output-reserve"],
      [{ protocolOverheadTokens: -1 }, "invalid-protocol-overhead"],
      [{ media: "unknown" }, "unknown-media"],
      [{ system: { kind: "unknown" } }, "unknown-system"],
      [{ tools: [{ execute: () => undefined }] }, "unknown-content"],
    ]
    for (const [overrides, reason] of cases) {
      expect(estimateContextFoldingBudget(budgetInput([], overrides)).skipReason).toBe(reason)
    }
  })

  test("re-estimates current messages and tool schemas", () => {
    const base = estimateContextFoldingBudget(budgetInput([{ role: "user", content: "hello" }]))
    const changedMessages = estimateContextFoldingBudget(budgetInput([{ role: "user", content: "hello".repeat(500) }]))
    const changedTools = estimateContextFoldingBudget(
      budgetInput([{ role: "user", content: "hello" }], {
        tools: [{ name: "read", description: "d".repeat(2_000), schema: { type: "object" } }],
      }),
    )
    expect(changedMessages.estimatedInputTokens!).toBeGreaterThan(base.estimatedInputTokens!)
    expect(changedTools.estimatedInputTokens!).toBeGreaterThan(base.estimatedInputTokens!)
  })
})

describe("context folding projection", () => {
  test("U15 keeps an over-budget request with only unique content unchanged", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const result = projectContextFoldingRequest({ ...input, duplicatePlan: emptyDuplicatePlan })
    expect(result.request).toBe(input.request)
    expect(result).toMatchObject({ applied: false, plan: { overBudget: true, skipReason: "no-eligible-duplicates" } })
  })

  test("U16 includes placeholder/reference cost at the 511/512/513 token boundary", () => {
    for (const savings of [511, 512, 513]) {
      const { input } = projectionFixture(bodyForSavings(savings))
      const result = projectContextFoldingRequest(input)
      expect(result.applied).toBe(savings >= 512)
      expect(result.plan.skipReason).toBe(savings >= 512 ? undefined : "insufficient-savings")
      if (result.applied) expect(result.plan.replacements[0].estimatedSavings).toBe(savings)
    }
  })

  test("selects old sources in order, stops at target, and can remain over budget after exhaustion", () => {
    const firstBody = bodyForSavings(700, "visible-witness-a")
    const secondBody = bodyForSavings(700, "visible-witness-b")
    const refs = [ref("source-a"), ref("witness-a"), ref("source-b"), ref("witness-b")]
    const visible = ["visible-source-a", "visible-witness-a", "visible-source-b", "visible-witness-b"]
    const request = {
      messages: refs.flatMap((_, index) => [
        { role: "assistant", callID: visible[index] },
        { role: "tool", callID: visible[index], body: index < 2 ? firstBody : secondBody },
      ]),
      metadata: { mutable: "original" },
    }
    const identity = { model: "test", request }
    const fingerprint = fingerprintContextFoldingRequest(identity)
    if (!fingerprint.ok) throw new Error(fingerprint.reason)
    const mapping: WireProjectionSnapshot = {
      requestFingerprint: fingerprint.value,
      calls: refs.map((item, ordinal) => ({ ref: item, visibleCallID: visible[ordinal], ordinal })),
      results: refs.map((item, ordinal) => ({
        ref: item,
        visibleCallID: visible[ordinal],
        ordinal,
        bodyPath: ["messages", ordinal * 2 + 1, "body"],
        complete: true,
      })),
    }
    const duplicate: FoldPlan = {
      replacements: [
        { source: refs[0], witness: refs[1] },
        { source: refs[2], witness: refs[3] },
      ],
      protectedStepIDs: [],
      exclusions: [],
      skipReason: undefined,
    }
    const baseBudget = estimateContextFoldingBudget(
      budgetInput(request.messages, { contextLimit: 100_000, outputReserve: 1_000 }),
    )
    const desiredTarget = baseBudget.estimatedInputTokens! - 699
    const usable = Math.ceil(desiredTarget / ContextFoldingPolicy.softTargetRatio)
    const stopsAfterOne = projectContextFoldingRequest({
      request,
      identity,
      expectedRequestFingerprint: fingerprint.value,
      duplicatePlan: duplicate,
      budget: budgetInput(request.messages, { contextLimit: usable + 100, outputReserve: 100 }),
      mapping,
    })
    expect(stopsAfterOne.plan.replacements).toHaveLength(1)
    expect(stopsAfterOne.plan.overBudget).toBe(false)

    const exhausted = projectContextFoldingRequest({
      request,
      identity,
      expectedRequestFingerprint: fingerprint.value,
      duplicatePlan: duplicate,
      budget: budgetInput(request.messages, { contextLimit: 1_000, outputReserve: 100, protocolOverheadTokens: 5_000 }),
      mapping,
    })
    expect(exhausted.plan.replacements).toHaveLength(2)
    expect(exhausted.plan.overBudget).toBe(true)
  })

  test("escapes a bounded final wire call ID and rejects overlong or colliding IDs", () => {
    const unusual = 'visible-"witness\\line\nnext'
    const { input } = projectionFixture(bodyForSavings(600, unusual), "visible-source", unusual)
    const applied = projectContextFoldingRequest(input)
    expect(applied.applied).toBe(true)
    expect(applied.request.messages[1].body).toBe(expectedPlaceholder(unusual))

    const long = "x".repeat(ContextFoldingPolicy.maximumVisibleCallIDBytes + 1)
    const longFixture = projectionFixture(bodyForSavings(600, long), "visible-source", long)
    expect(projectContextFoldingRequest(longFixture.input)).toMatchObject({
      applied: false,
      plan: { skipReason: "invalid-reference" },
    })

    const collision = projectionFixture(bodyForSavings(600), "same-id", "same-id")
    expect(projectContextFoldingRequest(collision.input)).toMatchObject({
      applied: false,
      plan: { skipReason: "mapping-mismatch" },
    })
  })

  test("rejects missing, truncated, stale, reordered, or body-mismatched witness mappings", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const malformedCompleteness = input.mapping.results.map((item) => ({ ...item }))
    Reflect.set(malformedCompleteness[1], "complete", "yes")
    const variants: ContextFoldingProjectionInput<WireRequest>[] = [
      { ...input, mapping: { ...input.mapping, results: input.mapping.results.slice(0, 1) } },
      {
        ...input,
        mapping: {
          ...input.mapping,
          results: input.mapping.results.map((item, index) => (index === 1 ? { ...item, complete: false } : item)),
        },
      },
      {
        ...input,
        mapping: {
          ...input.mapping,
          results: input.mapping.results.map((item, index) => (index === 0 ? { ...item, ordinal: 2 } : item)),
        },
      },
      {
        ...input,
        mapping: {
          ...input.mapping,
          calls: input.mapping.calls.map((item, index) => (index === 1 ? { ...item, ordinal: 0 } : item)),
        },
      },
      { ...input, mapping: { ...input.mapping, results: malformedCompleteness } },
      {
        ...input,
        request: {
          ...input.request,
          messages: input.request.messages.map((item, index) => (index === 3 ? { ...item, body: "changed" } : item)),
        },
      },
    ]
    for (const variant of variants) {
      const result = projectContextFoldingRequest(variant)
      expect(result.request).toBe(variant.request)
      expect(result.applied).toBe(false)
    }

    const changedIdentity = { model: "changed-model", runtime: "test-runtime", request: input.request, tools: [] }
    expect(projectContextFoldingRequest({ ...input, identity: changedIdentity })).toMatchObject({
      applied: false,
      plan: { skipReason: "stale-request" },
    })
  })

  test("applies to a fully independent copy, accepts frozen inputs, and never mutates the source", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const original = JSON.stringify(input.request)
    deepFreeze(input)
    const result = projectContextFoldingRequest(input)
    expect(result.applied).toBe(true)
    expect(JSON.stringify(input.request)).toBe(original)
    expect(result.request).not.toBe(input.request)
    result.request.metadata.mutable = "projected-only"
    expect(input.request.metadata.mutable).toBe("original")
  })

  test("discards a private partial copy when projection fails midway", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const original = JSON.stringify(input.request)
    const result = projectContextFoldingRequest(input, {
      afterReplacement: () => {
        throw new Error("injected projection failure")
      },
    })
    expect(result.request).toBe(input.request)
    expect(result).toMatchObject({ applied: false, plan: { skipReason: "projection-failed" } })
    expect(JSON.stringify(input.request)).toBe(original)
  })

  test("detects shared-reference pollution and discards the private copy", () => {
    const body = bodyForSavings(600)
    const source = ref("aliased-source")
    const witness = ref("aliased-witness")
    const shared = { body }
    const request = {
      messages: [{ result: shared }, { result: shared }],
      metadata: { mutable: "original" },
    }
    const identity = { model: "test", request }
    const fingerprint = fingerprintContextFoldingRequest(identity)
    if (!fingerprint.ok) throw new Error(fingerprint.reason)
    const input: ContextFoldingProjectionInput<typeof request> = {
      request,
      identity,
      expectedRequestFingerprint: fingerprint.value,
      duplicatePlan: duplicatePlan(source, witness),
      budget: budgetInput(request.messages),
      mapping: {
        requestFingerprint: fingerprint.value,
        calls: [
          { ref: source, visibleCallID: "source", ordinal: 0 },
          { ref: witness, visibleCallID: "witness", ordinal: 1 },
        ],
        results: [
          {
            ref: source,
            visibleCallID: "source",
            ordinal: 0,
            bodyPath: ["messages", 0, "result", "body"],
            complete: true,
          },
          {
            ref: witness,
            visibleCallID: "witness",
            ordinal: 1,
            bodyPath: ["messages", 1, "result", "body"],
            complete: true,
          },
        ],
      },
    }
    const result = projectContextFoldingRequest(input)
    expect(result.request).toBe(request)
    expect(result.plan.skipReason).toBe("projection-failed")
    expect(shared.body).toBe(body)
  })

  test("does not chain or damage an already projected request", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const first = projectContextFoldingRequest(input)
    expect(first.applied).toBe(true)
    const second = projectContextFoldingRequest({ ...input, request: first.request })
    expect(second.request).toBe(first.request)
    expect(second.applied).toBe(false)
    expect(second.plan.skipReason).toBe("already-projected")
  })
})

describe("context folding resource limits", () => {
  const candidate = (
    id: string,
    input: unknown = { filePath: "/workspace/file.ts" },
    text = "body",
  ): FoldCandidate => ({
    ref: ref(id),
    toolName: "read",
    source: {
      sessionID: "session",
      assistantMessageID: `message-${id}`,
      callID: `call-${id}`,
      toolName: "read",
      sourceKind: "host-builtin",
      registrationID: "builtin-read",
      registrationGeneration: "generation-1",
    },
    status: "completed",
    input,
    result: { kind: "text", text, complete: true },
    safety: { attachments: "none", instructions: "none", providerExecuted: false },
    targetPath: "/workspace/file.ts",
  })
  const step = (id: string, candidates: readonly FoldCandidate[] = []): FoldStep => ({
    id,
    estimatedTokens: 4_000,
    candidates,
  })

  test("guards deep, oversized, sparse, and excessive candidate inputs before unbounded construction", () => {
    let deep: unknown = "leaf"
    for (let index = 0; index <= ContextFoldingPolicy.workLimits.maxDepth; index++) deep = { value: deep }
    expect(normalizeParameters(deep)).toEqual({ ok: false })

    const sparse: unknown[] = []
    sparse.length = ContextFoldingPolicy.workLimits.maxContainerEntries + 1
    expect(normalizeParameters(sparse)).toEqual({ ok: false })

    const huge = "x".repeat(ContextFoldingPolicy.workLimits.maxInputBytes + 1)
    expect(planContextFolding([step("huge", [candidate("huge", { value: huge }, huge)])]).skipReason).toBe("work-limit")

    const many = Array.from({ length: ContextFoldingPolicy.maximumCandidates + 1 }, (_, index) =>
      candidate(`many-${index}`),
    )
    expect(planContextFolding([step("many", many)]).skipReason).toBe("work-limit")
  })

  test("bounds degenerate fingerprint buckets without approximate equality", () => {
    const candidates = Array.from({ length: ContextFoldingPolicy.maximumFingerprintBucketEntries + 1 }, (_, index) =>
      candidate(`collision-${index}`, { filePath: `/workspace/${index}.ts` }, `body-${index}`),
    )
    const plan = planContextFolding([step("collisions", candidates)], { fingerprint: () => "one-bucket" })
    expect(plan).toMatchObject({ replacements: [], skipReason: "work-limit" })
  })

  test("budget estimation skips oversized request content instead of approximating it", () => {
    const huge = "x".repeat(ContextFoldingPolicy.workLimits.maxInputBytes + 1)
    expect(estimateContextFoldingBudget(budgetInput([{ role: "user", content: huge }]))).toMatchObject({
      estimatedInputTokens: undefined,
      skipReason: "work-limit",
    })

    const multibyte = "你".repeat(Math.floor(ContextFoldingPolicy.workLimits.maxInputBytes / 3) + 1)
    expect(multibyte.length).toBeLessThan(ContextFoldingPolicy.workLimits.maxInputBytes)
    expect(estimateContextFoldingBudget(budgetInput([{ role: "user", content: multibyte }]))).toMatchObject({
      estimatedInputTokens: undefined,
      skipReason: "work-limit",
    })
  })

  test("bounds final wire mappings before allocating validation indexes", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const calls = Array.from({ length: ContextFoldingPolicy.maximumCandidates + 1 }, (_, index) => ({
      ref: ref(`mapping-${index}`),
      visibleCallID: `visible-${index}`,
      ordinal: index,
    }))
    const result = projectContextFoldingRequest({ ...input, mapping: { ...input.mapping, calls } })
    expect(result.request).toBe(input.request)
    expect(result).toMatchObject({ applied: false, plan: { skipReason: "work-limit" } })
  })
})
