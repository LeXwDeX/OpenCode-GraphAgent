/**
 * DAG prompt-template resolver.
 *
 * Resolves a node's `prompt_template` declaration into a final prompt string:
 * - `id` reference → reads the `.md` file from project (`.opencode/dag-prompts/`)
 *   or global (`~/.config/opencode/dag-prompts/`) directory
 * - `inline` → writes the string to a temp file under `os.tmpdir()`, reads it,
 *   then deletes it after resolution
 *
 * Both paths go through `{{var}}` interpolation and `sanitize()`.
 *
 * The template library is NOT loaded at startup. Files are read lazily at
 * resolve time — if no node references a template, zero files are read.
 */

import { Effect } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { sanitizeInput } from "./sanitize"

export interface TemplateRef {
  id?: string
  inline?: string
  input?: Record<string, unknown>
}

const INTERPOLATION_RE = /{{\s*([^{}]+?)\s*}}/g

/** A template id must be a single path segment (no separators, no parent refs)
 * so it cannot escape the dag-prompts directory via path traversal. */
function isSafeTemplateId(id: string): boolean {
  return id.length > 0 && !id.includes("/") && !id.includes("\\") && id !== "." && id !== ".."
}

/**
 * Resolve a template reference into a final prompt string.
 *
 * @param ref         The prompt_template declaration from the node config
 * @param projectDir  The project root (for `.opencode/dag-prompts/` lookup)
 */
export function resolveTemplate(ref: TemplateRef, projectDir: string): Effect.Effect<string, Error> {
  return renderTemplate(ref, projectDir).pipe(Effect.map((result) => result.text))
}

export function renderTemplate(
  ref: TemplateRef,
  projectDir: string,
  dynamicInput: Record<string, unknown> = {},
) {
  return Effect.gen(function* () {
    const input = sanitizeInput({ ...dynamicInput, ...(ref.input ?? {}) })
    const raw = yield* readTemplateSource(ref, projectDir)
    return interpolate(raw, input)
  })
}

function readTemplateSource(ref: TemplateRef, projectDir: string): Effect.Effect<string, Error> {
  if (ref.inline !== undefined) {
    return readInline(ref.inline)
  }
  if (ref.id) {
    return readById(ref.id, projectDir)
  }
  return Effect.fail(new Error("prompt_template must have either 'id' or 'inline'"))
}

function readInline(content: string): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    // Write to temp file (os.tmpdir() — NEVER hardcoded /tmp/)
    const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dag-inline-")))
    const filePath = path.join(dir, "prompt.md")
    yield* Effect.promise(() => fs.writeFile(filePath, content, "utf-8"))
    // Read it back (simulating the template-file read path)
    const raw = yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))
    // Delete temp file (use-once-and-discard)
    yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(
      Effect.catch(() => Effect.void),
    )
    return raw
  })
}

function readById(id: string, projectDir: string): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    // Reject path traversal: a template id must be a single path segment so it
    // cannot escape the dag-prompts directory. "\" is rejected for Windows,
    // where it is a path separator.
    if (!isSafeTemplateId(id)) {
      return yield* Effect.fail(new Error(`Invalid template id: ${id}`))
    }
    const projectPath = path.join(projectDir, ".opencode", "dag-prompts", `${id}.md`)
    const globalPath = path.join(os.homedir(), ".config", "opencode", "dag-prompts", `${id}.md`)

    // Try project first (overrides global), then global
    const result = yield* Effect.promise(async () => {
      try {
        return await fs.readFile(projectPath, "utf-8")
      } catch {
        try {
          return await fs.readFile(globalPath, "utf-8")
        } catch {
          throw new Error(`Template not found: ${id} (checked project and global dirs)`)
        }
      }
    })
    return result
  })
}

function interpolate(template: string, input: Record<string, unknown>) {
  const unresolvedPlaceholders: string[] = []
  const text = template.replace(INTERPOLATION_RE, (match, key: string) => {
    const value = input[key]
    if (value !== null && value !== undefined) return String(value)
    unresolvedPlaceholders.push(key)
    return match
  })
  return { text, unresolvedPlaceholders }
}
