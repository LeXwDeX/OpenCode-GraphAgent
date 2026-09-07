import z from "zod"

export const HookCommandSchema = z
  .object({
    type: z.enum(["command", "mcp", "http", "prompt", "agent"]),
    command: z.string().optional(),
    url: z.string().optional(),
    prompt: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional(),
    timeout: z.number().positive().finite().optional(),
    statusMessage: z.string().optional(),
    once: z.boolean().optional(),
    shell: z.enum(["bash", "powershell"]).optional(),
    if: z.string().optional(),
    async: z.boolean().optional(),
    asyncRewake: z.boolean().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    __sourceDir: z.string().optional(),
  })
  .superRefine((entry, ctx) => {
    const value =
      entry.type === "http"
        ? (entry.url ?? entry.command)
        : entry.type === "prompt" || entry.type === "agent"
          ? (entry.prompt ?? entry.command)
          : entry.command
    if (!value?.trim())
      ctx.addIssue({ code: "custom", message: `${entry.type} hook requires a nonempty command, url or prompt` })
  })

export const HookSpecificOutputSchema = z.object({
  hookEventName: z.string().optional(),
  permissionDecision: z.enum(["allow", "deny", "ask"]).optional(),
  permissionDecisionReason: z.string().optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  additionalContext: z.string().optional(),
  initialUserMessage: z.string().optional(),
  updatedMCPToolOutput: z.unknown().optional(),
  watchPaths: z.array(z.string()).optional(),
  displayMessage: z.string().optional(),
  compactSummary: z.string().optional(),
  customSummary: z.string().optional(),
})

export const HookOutputSchema = z.object({
  continue: z.boolean().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
  decision: z.enum(["approve", "block"]).optional(),
  reason: z.string().optional(),
  hookSpecificOutput: HookSpecificOutputSchema.optional(),
})
