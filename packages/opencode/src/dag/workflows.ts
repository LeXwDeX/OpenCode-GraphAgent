/**
 * Workflow library — reusable start specs discovered by name.
 *
 * Named workflows let a spec live as a durable project asset instead of a
 * throwaway file the agent must rewrite per run. `workflow(spec_path: "x")`
 * resolves through this module; a path-shaped `spec_path` bypasses it and keeps
 * the original session-relative behavior.
 *
 * Lookup order (project overrides global, first match wins):
 * - project: `.opencode/workflows/<name>.yaml` / `.yml`
 * - global:  `<config dir>/workflows/<name>.yaml` / `.yml`
 *
 * Mirrors config.ts: same two-level scope, same OPENCODE_CONFIG_DIR redirect,
 * read lazily so edits apply on the next call and startup stays untouched.
 */

export * as DagWorkflows from "./workflows"

import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { isRecord } from "@/util/record"

const DIRECTORY = "workflows"
const EXTENSIONS = [".yaml", ".yml"]

export type Scope = "project" | "global"

export interface Entry {
  readonly name: string
  readonly scope: Scope
  readonly path: string
  /** Workflow title from the spec, when the file declares one. */
  readonly title?: string
  /** Node count, for a one-glance sense of the graph's size. */
  readonly nodes?: number
}

/** A name has no path separators and no YAML extension — those mean a path. */
export function isName(value: string) {
  if (!value) return false
  if (value.includes("/") || value.includes("\\")) return false
  if (EXTENSIONS.includes(path.extname(value).toLowerCase())) return false
  // Control characters are never valid in a filename, and a NUL makes the fs
  // calls in resolve() reject — which surfaces as a raw TypeError instead of
  // the actionable "not found" message. Let the path branch reject it.
  if (/[\u0000-\u001f]/.test(value)) return false
  // Leave `.` and `..` to the path branch; they are directories, not names.
  return !value.startsWith(".")
}

/**
 * Resolve a workflow name to its file. Returns undefined when no scope holds
 * it, so callers can report the searched locations instead of a bare ENOENT.
 */
export function resolve(name: string, projectDir: string): Effect.Effect<Entry | undefined> {
  return Effect.promise(async () => {
    for (const scope of scopes(projectDir)) {
      for (const extension of EXTENSIONS) {
        const file = path.join(scope.dir, `${name}${extension}`)
        if (!(await Bun.file(file).exists())) continue
        return { name, scope: scope.scope, path: file, ...(await describe(file)) }
      }
    }
    return undefined
  })
}

/** Every directory a named workflow may live in, in resolution order. */
export function searchPaths(projectDir: string) {
  return scopes(projectDir).map((scope) => scope.dir)
}

/**
 * List available workflows. A project entry shadows a global one with the same
 * name, matching resolve()'s precedence so the listing never advertises a file
 * that resolve() would not pick.
 */
export function list(projectDir: string): Effect.Effect<Entry[]> {
  return Effect.promise(async () => {
    const seen = new Map<string, Entry>()
    for (const scope of scopes(projectDir)) {
      const entries = await fs.readdir(scope.dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const extension = path.extname(entry.name).toLowerCase()
        if (!EXTENSIONS.includes(extension)) continue
        const name = path.basename(entry.name, extension)
        if (seen.has(name)) continue
        const file = path.join(scope.dir, entry.name)
        seen.set(name, { name, scope: scope.scope, path: file, ...(await describe(file)) })
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  })
}

// Resolution order, project first. The global directory applies the same
// OPENCODE_CONFIG_DIR redirect the Global service applies in make(), so managed
// setups pointing the config dir elsewhere are honored here too.
function scopes(projectDir: string) {
  return [
    { scope: "project" as const, dir: path.join(projectDir, ".opencode", DIRECTORY) },
    { scope: "global" as const, dir: path.join(Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config, DIRECTORY) },
  ]
}

/**
 * Best-effort listing metadata. A malformed or unreadable spec still lists —
 * hiding it would make a typo look like a missing file; the start path reports
 * the real parse error.
 */
async function describe(file: string): Promise<{ title?: string; nodes?: number }> {
  const parsed = await Bun.file(file)
    .text()
    .then((text) => Bun.YAML.parse(text))
    .catch(() => undefined)
  if (!isRecord(parsed)) return {}
  const config = isRecord(parsed["config"]) ? parsed["config"] : undefined
  const title = typeof parsed["title"] === "string" ? parsed["title"] : undefined
  const nodes = config && Array.isArray(config["nodes"]) ? config["nodes"].length : undefined
  return { ...(title ? { title } : {}), ...(nodes === undefined ? {} : { nodes }) }
}
