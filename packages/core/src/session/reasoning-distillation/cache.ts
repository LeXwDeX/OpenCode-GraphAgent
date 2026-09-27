import { ReasoningDistillationPolicy } from "./policy"
import type { Candidate, DistillationKey, ValidationStamp } from "./types"

/**
 * Candidate/certificate cache (§5.8). Immutable: every operation returns a new cache, so the pure core never mutates
 * shared state. Entries are insertion-ordered; eviction removes the oldest until both the entry cap and the total
 * derived-body cap hold. A cache hit is NEVER returned as verified on its own — the caller must rebind the certificate
 * to the current evidence (§5.8: "命中缓存仍重绑证据"), and a model/endpoint/variant change produces a different key,
 * so a stale certificate is never reused.
 */

export type CacheEntry = Readonly<{
  key: DistillationKey
  candidate: Candidate
  /** The validation certificate produced when the candidate was verified; undefined for an unvalidated candidate. */
  certificate: ValidationStamp | undefined
  /** Approximate derived-body size in bytes, charged against the cache body budget. */
  derivedBodyBytes: number
}>

export type DistillationCache = Readonly<{
  /** Insertion-ordered entries; eviction removes from the front. */
  entries: readonly CacheEntry[]
  totalDerivedBodyBytes: number
}>

export const emptyCache: DistillationCache = { entries: [], totalDerivedBodyBytes: 0 }

const SEP = "\u0000"

/** The full cache key identity, including source/capability/organizer fingerprints and policy version. */
export const cacheKeyFingerprint = (key: DistillationKey): string =>
  [
    key.sessionID,
    key.messageID,
    key.partIDs.join(","),
    key.sourceFingerprint,
    key.capabilityFingerprint,
    key.organizerFingerprint,
    key.policyVersion,
  ].join(SEP)

export const cacheLookup = (cache: DistillationCache, key: DistillationKey): CacheEntry | undefined => {
  const fingerprint = cacheKeyFingerprint(key)
  return cache.entries.find((entry) => cacheKeyFingerprint(entry.key) === fingerprint)
}

const totalBytes = (entries: readonly CacheEntry[]): number =>
  entries.reduce((sum, entry) => sum + entry.derivedBodyBytes, 0)

/**
 * Insert an entry, evicting the oldest until within both caps. An entry larger than the whole derived-body budget can
 * never fit and is skipped (§5.8: "单项超过剩余预算可跳过缓存"). Re-inserting an existing key replaces it at the back.
 */
export const cacheInsert = (cache: DistillationCache, entry: CacheEntry): DistillationCache => {
  const { maxEntries, maxDerivedBodyBytes } = ReasoningDistillationPolicy.cache
  if (entry.derivedBodyBytes > maxDerivedBodyBytes) return cache

  const fingerprint = cacheKeyFingerprint(entry.key)
  const retained = cache.entries.filter((existing) => cacheKeyFingerprint(existing.key) !== fingerprint)
  let entries = [...retained, entry]
  let bytes = totalBytes(retained) + entry.derivedBodyBytes

  while (entries.length > 0 && (entries.length > maxEntries || bytes > maxDerivedBodyBytes)) {
    bytes -= entries[0].derivedBodyBytes
    entries = entries.slice(1)
  }
  return { entries, totalDerivedBodyBytes: bytes }
}

/**
 * A cached certificate is reusable only when it was produced under the evidence the caller now holds. The cache key
 * already binds source/capability/organizer identity, so a hit guarantees those match; only the evidence (call
 * inventory) fingerprint can drift independently and must be rechecked (§5.8, §6.1 "缓存后证据变化").
 */
export const isCertificateCurrent = (entry: CacheEntry, currentEvidenceFingerprint: string): boolean =>
  entry.certificate !== undefined && entry.certificate.evidenceFingerprint === currentEvidenceFingerprint
