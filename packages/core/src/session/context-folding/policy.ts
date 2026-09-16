export const ContextFoldingPolicy = {
  allowedTools: ["read", "grep", "glob"] as const,
  protectedInstructionBasenames: ["agents.md", "agents.override.md", "claude.md", "context.md", "skill.md"] as const,
  protectRecentSteps: 4,
  protectRecentTokens: 16_000,
} as const
