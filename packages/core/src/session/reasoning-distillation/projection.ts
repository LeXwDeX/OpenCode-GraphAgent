import { Hash } from "../../util/hash"
import { Token } from "../../util/token"
import { fingerprintContextFoldingRequest } from "../context-folding/projection"
import type { WirePathSegment } from "../context-folding/types"
import { cloneWireValue, readWirePath, verifyWireValueChanges, writeWirePath } from "../context-folding/wire-value"
import { ReasoningDistillationPolicy } from "./policy"
import type { DistillationProjectionInput, DistillationProjectionResult, DistillationSkipReason } from "./types"

/**
 * Independent distillation projector (§5.2). Reuses the folding wire primitives — private copy, path read/write,
 * change verification, lossless serialization, request fingerprint — but never calls projectContextFoldingRequest and
 * never relaxes the guards. It replaces each eligible reasoning slot body with the rendered projection, binding by
 * source fingerprint (which also gives idempotency: an already-projected body no longer matches, so a repeat call
 * never double-wraps, and a user body that happens to contain a marker word is never mistaken for projected). Every
 * failure path returns the EXACT original request object (§5.2: "任一步失败返回传入的同一请求对象").
 */

type PreparedReplacement = Readonly<{
  path: readonly WirePathSegment[]
  before: string
  after: string
  savings: number
}>

const pathID = (path: readonly WirePathSegment[]): string =>
  JSON.stringify(path.map((segment) => [typeof segment === "number" ? "n" : "s", segment]))

export const projectDistillationRequest = <Request>(
  input: DistillationProjectionInput<Request>,
): DistillationProjectionResult<Request> => {
  const unchanged = (skipReason: DistillationSkipReason): DistillationProjectionResult<Request> => ({
    request: input.request,
    applied: false,
    skipReason,
  })
  try {
    if (input.replacements.length === 0) return unchanged("mapping-mismatch")

    // Request-fingerprint binding (reuses the folding primitive): a changed request is stale, never partially written.
    const current = fingerprintContextFoldingRequest({
      request: input.request,
      identity: input.identity,
      budget: input.budget,
    })
    if (!current.ok) return unchanged(current.reason === "work-limit" ? "work-limit" : "projection-failed")
    if (!input.expectedRequestFingerprint || current.value !== input.expectedRequestFingerprint) {
      return unchanged("stale-request")
    }

    // Validate and bind each replacement against the live slot body.
    const prepared: PreparedReplacement[] = []
    const seenPaths = new Set<string>()
    for (const replacement of input.replacements) {
      const { mapping, projection } = replacement
      if (!mapping.eligibility.allowed) return unchanged("no-rewritable-slot")
      const path = mapping.bodyPath
      const id = pathID(path)
      // W1 multi-part-to-single-slot must not collide on one body path (§6.1).
      if (seenPaths.has(id)) return unchanged("mapping-mismatch")
      seenPaths.add(id)

      const body = readWirePath(input.request, path)
      if (!body.ok) return unchanged(body.reason === "work-limit" ? "work-limit" : "projection-failed")
      if (typeof body.value !== "string") return unchanged("mapping-mismatch")
      // Source-fingerprint binding + idempotency: the live body must equal the planned source.
      if (Hash.sha256(body.value) !== mapping.sourceFingerprint) return unchanged("stale-validation")

      const after = projection.text
      const savings = Token.estimate(body.value) - Token.estimate(after)
      if (savings < ReasoningDistillationPolicy.tokens.minimumNetSavingsTokens) {
        return unchanged("insufficient-net-savings")
      }
      prepared.push({ path, before: body.value, after, savings })
    }

    // Apply to a private serializable copy; the original request object is never mutated.
    const copy = cloneWireValue(input.request)
    if (!copy.ok) return unchanged(copy.reason === "work-limit" ? "work-limit" : "projection-failed")

    for (const item of prepared) {
      if (!writeWirePath(copy.value, item.path, item.after)) return unchanged("projection-failed")
    }
    for (const item of prepared) {
      const projected = readWirePath(copy.value, item.path)
      if (!projected.ok || projected.value !== item.after) return unchanged("projection-failed")
    }
    const verification = verifyWireValueChanges(
      input.request,
      copy.value,
      prepared.map((item) => ({ path: item.path, before: item.before, after: item.after })),
    )
    if (!verification.ok) return unchanged(verification.reason === "work-limit" ? "work-limit" : "projection-failed")
    if (!verification.value) return unchanged("projection-failed")

    return { request: copy.value, applied: true, skipReason: undefined }
  } catch {
    return unchanged("projection-failed")
  }
}
