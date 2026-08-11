export * as MemoryPaths from "./paths"

import { join } from "node:path"

/** Worktree-local paths containing durable project memory. */
export const PROJECT_PATHS = [".opencode/memory.jsonc", ".opencode/memory.json", ".opencode/memory/"] as const

export const PROJECT_CONFIG_PATHS = [".opencode/memory.jsonc", ".opencode/memory.json"] as const

export const LEGACY_TOPICS_PATH = ".opencode/memory/topics"

export function legacyTopics(directory: string) {
  return join(directory, LEGACY_TOPICS_PATH)
}

export function isProjectMemoryPath(input: string) {
  const path = input.replaceAll("\\", "/").replace(/^\.\//, "")
  return PROJECT_PATHS.some((candidate) => (candidate.endsWith("/") ? path.startsWith(candidate) : path === candidate))
}
