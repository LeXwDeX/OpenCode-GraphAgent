import { readWirePath } from "../context-folding/wire-value"
import { Hash } from "../../util/hash"
import type { CanonicalReasoning } from "./canonical"

export type ReasoningReplacement = Readonly<{
  messageID: string
  partID: string
  before: string
  after: string
}>

/** Collect every applied slot from the final request, including earlier slots in a multi-slot cycle. */
export function reasoningReplacements(
  request: unknown,
  slots: readonly Readonly<{
    messageID: string
    partID: string
    text: string
    bodyPath: readonly (string | number)[]
  }>[],
): ReasoningReplacement[] {
  return slots.flatMap((slot) => {
    const value = readWirePath(request, slot.bodyPath)
    if (!value.ok || typeof value.value !== "string" || value.value === slot.text) return []
    return [{ messageID: slot.messageID, partID: slot.partID, before: slot.text, after: value.value }]
  })
}

export const adoptionProvenance = (source: CanonicalReasoning) => ({
  originalText: source.text,
  sourceFingerprint: Hash.sha256(source.text),
  version: 2 as const,
  ...(source.metadata === undefined ? {} : { originalMetadata: source.metadata }),
})
