import type { PermissionRequest } from "@opencode-ai/sdk/v2"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const MAX_CHARS = 2_000

/**
 * The input a hook-forced ask will run with: a shell command as is, otherwise all arguments as JSON (so a path is
 * shown together with the content or edit it applies), bounded for the dock.
 */
export const hookAskInput = (request: Pick<PermissionRequest, "metadata">) => {
  const input = request.metadata?.hookAsk === true ? request.metadata.input : undefined
  if (!isRecord(input)) return ""
  const text = typeof input.command === "string" && input.command ? input.command : JSON.stringify(input, null, 2)
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… (truncated)` : text
}
