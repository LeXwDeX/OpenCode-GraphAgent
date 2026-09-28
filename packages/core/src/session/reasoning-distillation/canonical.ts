/** Pure editability contract for a persisted reasoning part. Provider adapters do not decide what may be rewritten. */
export type CanonicalReasoning = Readonly<{
  text: string
  metadata?: Record<string, unknown>
  settled: boolean
  distilled: boolean
}>

export type CanonicalProtection =
  | "empty-source"
  | "unsettled-source"
  | "already-distilled"
  | "protected-carrier"
  | "unknown-carrier"
  | "metadata-mismatch"

export type CanonicalEditability =
  | Readonly<{ editable: false; reason: CanonicalProtection }>
  | Readonly<{ editable: true; aliasPaths: readonly (readonly (string | number)[])[] }>

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Fail closed for nested signatures, encrypted payloads, cycles, or unbounded metadata. Arrays are traversed. */
const protectedCarrier = (value: unknown): "protected-carrier" | "unknown-carrier" | undefined => {
  const seen = new Set<object>()
  let count = 0
  let textBytes = 0
  const visit = (item: unknown, depth: number): "protected-carrier" | "unknown-carrier" | undefined => {
    if (typeof item === "string") {
      textBytes += item.length
      return textBytes > 1_000_000 ? "unknown-carrier" : undefined
    }
    if (item === null || item === undefined || typeof item === "number" || typeof item === "boolean") return undefined
    if (typeof item !== "object" || depth > 8 || seen.has(item) || ++count > 512) return "unknown-carrier"
    seen.add(item)
    for (const [key, child] of Object.entries(item)) {
      if (
        key === "signature" ||
        key === "reasoningOpaque" ||
        key === "encrypted_content" ||
        key === "encryptedContent" ||
        key === "reasoningEncryptedContent" ||
        key === "data"
      )
        return "protected-carrier"
      const nested = visit(child, depth + 1)
      if (nested) return nested
    }
    return undefined
  }
  return visit(value, 0)
}

/** Recognize only an exact, single plaintext mirror; unknown metadata is never edited by guessing. */
export const assessCanonicalReasoning = (source: CanonicalReasoning): CanonicalEditability => {
  if (!source.text.trim()) return { editable: false, reason: "empty-source" }
  if (!source.settled) return { editable: false, reason: "unsettled-source" }
  if (source.distilled) return { editable: false, reason: "already-distilled" }
  const metadata = source.metadata
  if (metadata === undefined) return { editable: true, aliasPaths: [] }
  if (!record(metadata)) return { editable: false, reason: "unknown-carrier" }
  if (Object.keys(metadata).length === 0) return { editable: true, aliasPaths: [] }
  const protectedReason = protectedCarrier(metadata)
  if (protectedReason) return { editable: false, reason: protectedReason }
  if (Object.keys(metadata).length !== 1) return { editable: false, reason: "unknown-carrier" }
  const namespace = Object.keys(metadata)[0]
  if (!namespace || !record(metadata[namespace])) return { editable: false, reason: "unknown-carrier" }
  const carrier = metadata[namespace]
  if (Object.keys(carrier).length !== 1 || !Array.isArray(carrier.reasoning_details))
    return { editable: false, reason: "unknown-carrier" }
  const details = carrier.reasoning_details
  if (details.length !== 1 || !record(details[0])) return { editable: false, reason: "unknown-carrier" }
  const detail = details[0]
  if (Object.keys(detail).some((key) => !["type", "text", "format", "index"].includes(key)))
    return { editable: false, reason: "unknown-carrier" }
  if (
    detail.type !== "reasoning.text" ||
    (detail.format !== undefined && detail.format !== "unknown") ||
    (detail.index !== undefined && detail.index !== 0)
  )
    return { editable: false, reason: "unknown-carrier" }
  if (detail.text !== source.text) return { editable: false, reason: "metadata-mismatch" }
  return { editable: true, aliasPaths: [[namespace, "reasoning_details", 0, "text"]] }
}

/** Edit a private copy and verify every declared alias changed with the authoritative text. */
export const replaceCanonicalReasoning = (
  source: CanonicalReasoning,
  after: string,
):
  | Readonly<{ text: string; metadata?: Record<string, unknown>; originalMetadata?: Record<string, unknown> }>
  | undefined => {
  const assessment = assessCanonicalReasoning(source)
  if (!assessment.editable || !after.trim() || after === source.text) return undefined
  if (source.metadata === undefined || Object.keys(source.metadata).length === 0)
    return { text: after, metadata: source.metadata }
  let copy: Record<string, unknown>
  try {
    copy = structuredClone(source.metadata)
  } catch {
    return undefined
  }
  for (const path of assessment.aliasPaths) {
    let current: unknown = copy
    for (const segment of path.slice(0, -1)) {
      if (Array.isArray(current) && typeof segment === "number") current = current[segment]
      else if (record(current) && typeof segment === "string") current = current[segment]
      else return undefined
    }
    const last = path[path.length - 1]
    if (typeof last === "number" && Array.isArray(current)) {
      if (current[last] !== source.text) return undefined
      current[last] = after
    } else if (typeof last === "string" && record(current)) {
      if (current[last] !== source.text) return undefined
      current[last] = after
    } else return undefined
  }
  return { text: after, metadata: copy, originalMetadata: source.metadata }
}

/** Resolve one authoritative text/carrier pair for replay; legacy adoption never changed its carrier. */
export const reasoningForReplay = (input: {
  text: string
  metadata?: Record<string, unknown>
  distillation?: {
    originalText: string
    version?: 2
    originalMetadata?: Record<string, unknown>
  }
  enabled: boolean
}): Readonly<{ text: string; metadata?: Record<string, unknown> }> => {
  const saved = input.distillation
  if (!saved) return { text: input.text, metadata: input.metadata }
  if (input.enabled && saved.version === 2) return { text: input.text, metadata: input.metadata }
  if (input.enabled) {
    // Legacy adoption changed only text. Reconstruct an exact plaintext mirror for send when possible;
    // otherwise preserve the known original pair instead of emitting contradictory text and metadata.
    if (input.metadata === undefined || Object.keys(input.metadata).length === 0)
      return { text: input.text, metadata: input.metadata }
    const edited = replaceCanonicalReasoning(
      {
        text: saved.originalText,
        metadata: input.metadata,
        settled: true,
        distilled: false,
      },
      input.text,
    )
    return edited
      ? { text: edited.text, metadata: edited.metadata }
      : { text: saved.originalText, metadata: input.metadata }
  }
  if (saved.version === 2) return { text: saved.originalText, metadata: saved.originalMetadata }
  // Legacy adoption changed only text; its stored metadata is still the original carrier.
  return { text: saved.originalText, metadata: input.metadata }
}
