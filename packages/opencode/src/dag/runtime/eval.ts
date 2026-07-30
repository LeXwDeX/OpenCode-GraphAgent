/**
 * DAG conditional-node evaluation + input_mapping resolution (task 2.16).
 *
 * Pure helpers invoked at spawn time (before creating the child session):
 * - evaluateCondition: decides if a node should run or be skipped
 * - resolveInputMapping: collects upstream outputs into a variables map
 *
 * Both are synchronous — they receive the upstream outputs already loaded
 * by the scheduling layer.
 */

import type { DagStore } from "@opencode-ai/core/dag/store"

const CONDITION_RE = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/

/**
 * Evaluate a node's `condition` expression.
 *
 * The condition is a simple expression evaluated against upstream node outputs.
 * Supported syntax: `nodeID.output.field == value` or `nodeID.output.field > N`.
 *
 * Returns `{ ok: true, value }` — `value` is true (run the node) or false (skip).
 * Returns `{ ok: false, error }` when the expression cannot be parsed, or when
 * a numeric comparison's operand is not a number (missing field path, plain
 * text output) — the caller MUST fail the node rather than running or silently
 * skipping it on an unevaluable condition.
 *
 * @example
 * ```ts
 * evaluateCondition(
 *   "explore-src.output.findings_count > 0",
 *   { "explore-src": { output: { findings_count: 3 } } }
 * ) // → { ok: true, value: true }
 * ```
 */
export function evaluateCondition(
  condition: string | undefined,
  outputs: Record<string, unknown>,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (!condition || condition.trim() === "") return { ok: true, value: true }

  const match = condition.match(CONDITION_RE)
  if (!match) return { ok: false, error: `condition unparseable: ${condition}` }

  const [, lhsRaw, op, rhsRaw] = match
  const lhs = resolvePath(lhsRaw.trim(), outputs)
  const rhs = parseValue(rhsRaw.trim())

  // Numeric comparisons on non-numeric or non-finite operands (missing field
  // path, plain-text output, NaN, "Infinity" parsed by parseValue) must fail
  // the node loudly — the alternative is a silent condition_false skip that
  // cascades through required downstream nodes, the same failure mode
  // conditionReference guards against at create time.
  if (op === ">" || op === "<" || op === ">=" || op === "<=") {
    if (typeof lhs !== "number" || !Number.isFinite(lhs))
      return { ok: false, error: `condition "${condition}": left operand resolved to ${describeOperand(lhs)}, expected a finite number` }
    if (typeof rhs !== "number" || !Number.isFinite(rhs))
      return { ok: false, error: `condition "${condition}": right operand ${describeOperand(rhs)} is not a finite number` }
    if (op === ">") return { ok: true, value: lhs > rhs }
    if (op === "<") return { ok: true, value: lhs < rhs }
    if (op === ">=") return { ok: true, value: lhs >= rhs }
    return { ok: true, value: lhs <= rhs }
  }

  // CONDITION_RE only produces the six operators; after the numeric block
  // only equality remains.
  if (op === "==") return { ok: true, value: lhs === rhs }
  return { ok: true, value: lhs !== rhs }
}

function describeOperand(value: unknown): string {
  if (value === undefined) return "undefined (field path not found)"
  if (value === null) return "null"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return `string "${value.length > 50 ? value.slice(0, 50) + "\u2026" : value}"`
  return typeof value
}

/**
 * NodeID referenced by a parseable condition's left-hand side, or null when
 * the condition is empty or unparseable. Used at create/replan time to reject
 * conditions referencing nodes outside `depends_on` — those would silently
 * resolve to undefined and evaluate false at spawn time (the worst failure
 * mode). Unparseable conditions are left to the runtime, which fails the node
 * loudly instead.
 */
export function conditionReference(condition: string | undefined): string | null {
  if (!condition || condition.trim() === "") return null
  const match = condition.match(CONDITION_RE)
  if (!match) return null
  return match[1]!.trim().split(".")[0] || null
}

/**
 * Resolve an input_mapping into a variables map for prompt interpolation.
 *
 * input_mapping shape: `{ "varName": "nodeID.output" }`
 * Output shape: `{ "varName": <resolved value> }`
 *
 * @example
 * ```ts
 * resolveInputMapping(
 *   { core_diff: "refactor-core.output" },
 *   (nodeID) => nodes.find(n => n.id === nodeID)
 * ) // → { core_diff: <refactor-core's output> }
 * ```
 */
export function resolveInputMapping(
  mapping: Record<string, string> | undefined,
  getOutput: (nodeID: string) => unknown,
): Record<string, unknown> {
  if (!mapping) return {}
  const result: Record<string, unknown> = {}
  for (const [varName, ref] of Object.entries(mapping)) {
    // ref format: "nodeID" or "nodeID.output" or "nodeID.output.field"
    const parts = ref.split(".")
    const nodeID = parts[0]!
    const base = getOutput(nodeID)
    if (parts.length === 1) {
      result[varName] = base
    } else {
      result[varName] = resolvePath(parts.slice(1).join("."), { output: base })
    }
  }
  return result
}

// --------------------------------------------------------------------------

function resolvePath(path: string, source: Record<string, unknown>): unknown {
  const parts = path.split(".")
  let current: unknown = source

  // If first part is a nodeID in source, start there
  if (parts[0] && parts[0] in source) {
    current = source[parts[0]]
    parts.shift()
  }

  for (const part of parts) {
    if (current == null) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function parseValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (trimmed === "null") return null
  const num = Number(trimmed)
  if (!isNaN(num)) return num
  // Strip quotes if present
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}
