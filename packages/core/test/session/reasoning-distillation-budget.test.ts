import { describe, expect, test } from "bun:test"
import {
  admitPaidCandidate,
  cacheInsert,
  cacheLookup,
  canJudge,
  canPropose,
  consumeJudge,
  consumePropose,
  emptyCache,
  emptyCallLedger,
  isCertificateCurrent,
  quotaIdentity,
  usageExceedsReserve,
  type CacheEntry,
  type Candidate,
  type DistillationKey,
  type ValidationStamp,
} from "../../src/session/reasoning-distillation"

const MiB = 1024 * 1024

const key = (overrides: Partial<DistillationKey> = {}): DistillationKey => ({
  sessionID: "s1",
  messageID: "m1",
  partIDs: ["p1"],
  sourceFingerprint: "src1",
  capabilityFingerprint: "cap1",
  organizerFingerprint: "org1",
  policyVersion: "reasoning-distillation-v1",
  ...overrides,
})

const minimalCandidate = (): Candidate => ({
  key: key(),
  fingerprint: "cand1",
  claims: [],
  preserved: [],
  coverage: [],
})

const cert = (evidenceFingerprint: string): ValidationStamp => ({
  candidateFingerprint: "cf1",
  evidenceFingerprint,
  capabilityFingerprint: "cap1",
  validatorVersion: "gates-v1",
  method: "deterministic",
})

const entry = (k: DistillationKey, derivedBodyBytes: number, certificate?: ValidationStamp): CacheEntry => ({
  key: k,
  candidate: minimalCandidate(),
  certificate,
  derivedBodyBytes,
})

describe("cache (§5.8)", () => {
  test("insert then lookup by the same key", () => {
    const cache = cacheInsert(emptyCache, entry(key(), 100, cert("e1")))
    expect(cacheLookup(cache, key())?.derivedBodyBytes).toBe(100)
  })

  test("a model/organizer change is a different key, so a stale certificate is never reused", () => {
    const cache = cacheInsert(emptyCache, entry(key({ organizerFingerprint: "org1" }), 100, cert("e1")))
    expect(cacheLookup(cache, key({ organizerFingerprint: "org2" }))).toBeUndefined()
  })

  test("a capability/endpoint change is a different key", () => {
    const cache = cacheInsert(emptyCache, entry(key({ capabilityFingerprint: "cap1" }), 100, cert("e1")))
    expect(cacheLookup(cache, key({ capabilityFingerprint: "cap2" }))).toBeUndefined()
  })

  test("eviction removes the oldest once the derived-body cap is exceeded", () => {
    let cache = emptyCache
    cache = cacheInsert(cache, entry(key({ messageID: "a" }), 6 * MiB))
    cache = cacheInsert(cache, entry(key({ messageID: "b" }), 6 * MiB))
    cache = cacheInsert(cache, entry(key({ messageID: "c" }), 6 * MiB))
    // 18 MiB > 16 MiB cap -> the oldest (a) is evicted; b and c remain at 12 MiB.
    expect(cache.entries.map((e) => e.key.messageID)).toEqual(["b", "c"])
    expect(cache.totalDerivedBodyBytes).toBe(12 * MiB)
    expect(cacheLookup(cache, key({ messageID: "a" }))).toBeUndefined()
  })

  test("a single entry larger than the whole body budget is skipped", () => {
    const cache = cacheInsert(emptyCache, entry(key(), 17 * MiB))
    expect(cache.entries).toHaveLength(0)
  })

  test("re-inserting the same key replaces it at the back without duplicating", () => {
    let cache = cacheInsert(emptyCache, entry(key(), 100, cert("e1")))
    cache = cacheInsert(cache, entry(key(), 200, cert("e2")))
    expect(cache.entries).toHaveLength(1)
    expect(cacheLookup(cache, key())?.derivedBodyBytes).toBe(200)
  })

  test("a certificate is current only under the evidence it was produced with", () => {
    const fresh = entry(key(), 100, cert("e1"))
    expect(isCertificateCurrent(fresh, "e1")).toBe(true)
    expect(isCertificateCurrent(fresh, "e2")).toBe(false)
    expect(isCertificateCurrent(entry(key(), 100), "e1")).toBe(false)
  })
})

describe("call budget (§5.8)", () => {
  test("propose and judge are each capped at one per source identity", () => {
    let ledger = emptyCallLedger
    expect(canPropose(ledger, key())).toBe(true)
    expect(canJudge(ledger, key())).toBe(true)
    ledger = consumePropose(ledger, key())
    expect(canPropose(ledger, key())).toBe(false)
    expect(canJudge(ledger, key())).toBe(true)
    ledger = consumeJudge(ledger, key())
    expect(canJudge(ledger, key())).toBe(false)
  })

  test("a model/organizer change does not reset the quota (same source identity)", () => {
    const ledger = consumePropose(emptyCallLedger, key({ organizerFingerprint: "org1" }))
    expect(canPropose(ledger, key({ organizerFingerprint: "org2" }))).toBe(false)
  })

  test("an evidence/source fingerprint change is a new identity with fresh quota", () => {
    const ledger = consumePropose(emptyCallLedger, key({ sourceFingerprint: "src1" }))
    expect(canPropose(ledger, key({ sourceFingerprint: "src2" }))).toBe(true)
  })

  test("quotaIdentity excludes model/capability/organizer fingerprints", () => {
    expect(quotaIdentity(key({ organizerFingerprint: "org1" }))).toBe(
      quotaIdentity(key({ organizerFingerprint: "org2" })),
    )
    expect(quotaIdentity(key({ capabilityFingerprint: "cap1" }))).toBe(
      quotaIdentity(key({ capabilityFingerprint: "cap2" })),
    )
    expect(quotaIdentity(key({ sourceFingerprint: "src1" }))).not.toBe(
      quotaIdentity(key({ sourceFingerprint: "src2" })),
    )
  })

  test("amortization admission compares the 8-send window against worst-case auxiliary cost", () => {
    expect(
      admitPaidCandidate({ singleSavingTokens: 1000, proposeWorstCaseTokens: 4000, judgeWorstCaseTokens: 3000 }),
    ).toBe(true)
    expect(
      admitPaidCandidate({ singleSavingTokens: 100, proposeWorstCaseTokens: 4000, judgeWorstCaseTokens: 3000 }),
    ).toBe(false)
  })

  test("a real overage or unknown metering pauses paid admission", () => {
    expect(usageExceedsReserve({ reservedTokens: 100, actualTokens: 150 })).toBe(true)
    expect(usageExceedsReserve({ reservedTokens: 100, actualTokens: undefined })).toBe(true)
    expect(usageExceedsReserve({ reservedTokens: 100, actualTokens: 80 })).toBe(false)
  })
})
