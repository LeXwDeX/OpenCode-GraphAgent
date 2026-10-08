import type { PermissionRequest } from "@opencode-ai/sdk/v2"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The input a hook-forced ask will run with: a command or path as is, otherwise its arguments as JSON. */
export const hookAskInput = (request: Pick<PermissionRequest, "metadata">) => {
  const input = request.metadata?.hookAsk === true ? request.metadata.input : undefined
  if (!isRecord(input)) return ""
  for (const key of ["command", "filePath", "path", "url"]) {
    const value = input[key]
    if (typeof value === "string" && value) return value
  }
  return JSON.stringify(input)
}
