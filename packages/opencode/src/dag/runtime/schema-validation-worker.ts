import { validateAgainstSchema } from "./schema-validator"

declare const self: Worker

self.onmessage = (event: MessageEvent<{ schema: Record<string, unknown>; payload: unknown }>) => {
  const { schema } = event.data
  let payload = event.data.payload
  let result = validateAgainstSchema(payload, schema)
  // Some providers stringify the JSON payload. Preserve the tool's existing
  // repair, within the same resource budget as the first validation.
  if (!result.ok && typeof payload === "string") {
    let parsed = false
    try {
      payload = JSON.parse(payload)
      parsed = true
    } catch {
      // Malformed JSON leaves the original validation failure intact.
    }
    if (parsed) result = validateAgainstSchema(payload, schema)
  }
  self.postMessage({ ...result, payload })
}
