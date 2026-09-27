export * as GoalJudge from "./judge"

import { Effect } from "effect"
import { GoalPrompts } from "./prompts"

/** Privacy-safe failure category: error tag or class name only, never the message (may echo wire content). */
const errorCategory = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    const tag = (cause as { _tag?: unknown })._tag
    if (typeof tag === "string") return tag
    const name = (cause as { name?: unknown }).name
    if (typeof name === "string") return name
  }
  return "unknown"
}

export interface JudgeResult {
  readonly verdict: "done" | "continue" | "blocked"
  readonly reason: string
  readonly parseFailed: boolean
  readonly failureCategory?: JudgeFailureCategory
}

export type JudgeFailureCategory =
  | "empty"
  | "truncated-json"
  | "malformed-json"
  | "invalid-shape"
  | "non-json"
  | "transport-error"

function verdict(value: unknown): JudgeResult | undefined {
  let result: JudgeResult | undefined
  if (value && typeof value === "object") {
    if (
      "verdict" in value &&
      (value.verdict === "done" || value.verdict === "continue" || value.verdict === "blocked") &&
      "reason" in value &&
      typeof value.reason === "string"
    )
      result = { verdict: value.verdict, reason: value.reason, parseFailed: false }
    else if ("done" in value && typeof value.done === "boolean" && "reason" in value && typeof value.reason === "string")
      result = { verdict: value.done ? "done" : "continue", reason: value.reason, parseFailed: false }
  }
  return result
}

function objectCandidates(input: string) {
  const values: string[] = []
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (start < 0) {
      if (char === "{") {
        start = index
        depth = 1
      }
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) {
      values.push(input.slice(start, index + 1))
      start = -1
    }
  }
  return { values, unclosed: start >= 0 }
}

function failed(category: JudgeFailureCategory, chars: number): JudgeResult {
  const detail =
    category === "empty"
      ? "返回空响应"
      : category === "truncated-json"
        ? "返回疑似截断的 JSON"
        : category === "malformed-json"
          ? "返回格式错误的 JSON"
          : category === "invalid-shape"
            ? "返回 JSON，但缺少有效 verdict/reason"
            : category === "non-json"
              ? "返回非 JSON 内容"
              : "调用失败（transport-error）"
  return {
    verdict: "continue",
    reason: `judge ${detail}（${chars} 字符）`,
    parseFailed: true,
    failureCategory: category,
  }
}

export function parseJudgeResponse(raw: string): JudgeResult {
  const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim()
  if (!stripped) return failed("empty", 0)

  try {
    return verdict(JSON.parse(stripped)) ?? failed("invalid-shape", stripped.length)
  } catch {}

  const candidates = objectCandidates(stripped)
  let malformed = false
  let invalidShape = false
  for (const candidate of candidates.values) {
    try {
      const parsed = verdict(JSON.parse(candidate))
      if (parsed) return parsed
      invalidShape = true
    } catch {
      malformed = true
    }
  }

  if (candidates.unclosed) return failed("truncated-json", stripped.length)
  if (invalidShape) return failed("invalid-shape", stripped.length)
  if (malformed || stripped.includes("{") || stripped.includes("}"))
    return failed("malformed-json", stripped.length)
  return failed("non-json", stripped.length)
}

export const run = Effect.fn("Goal.Judge.run")(function* (
  goal: string,
  response: string,
  subgoals: ReadonlyArray<string>,
  callLLM: (opts: {
    system: string
    user: string
    temperature: number
    maxTokens: number
    timeout: number
  }) => Effect.Effect<string, Error>,
) {
  const userPrompt = GoalPrompts.renderJudgeUserPrompt(goal, response, subgoals)

  return yield* callLLM({
    system: GoalPrompts.JUDGE_SYSTEM_PROMPT,
    user: userPrompt,
    temperature: 0,
    maxTokens: 200,
    timeout: GoalPrompts.DEFAULT_JUDGE_TIMEOUT_SECONDS,
  }).pipe(
    Effect.map((text) => parseJudgeResponse(text)),
    // Transport errors (timeout, network, non-JSON transport-level failure)
    // count toward the pause budget. Previously they returned
    // parseFailed: false, which reset consecutive_parse_failures and let a
    // flaky provider alternate bad-JSON and timeout indefinitely without
    // ever hitting MAX_CONSECUTIVE_PARSE_FAILURES. Returning parseFailed: true
    // feeds them through the same auto-pause path as parse failures, treating
    // "judge is unreliable" uniformly regardless of failure mode. The verdict
    // stays "continue" so a single transient blip does not stall the loop;
    // it only pauses after MAX_CONSECUTIVE_PARSE_FAILURES in a row.
    //
    // catchCause (not orElseSucceed): the production callLLM chain can
    // DEFECT — config first-use orDie, payload decode throws — and a defect
    // escaping here kills afterIdle invisibly (the loop stalls at 0 turns
    // with zero logs and no pause budget). catchCause folds defects into
    // the same parseFailed budget.
    Effect.catchCause((cause) =>
      Effect.logWarning("goal judge transport failure", {
        "goal.judge.error_category": errorCategory(cause),
      }).pipe(Effect.as(failed("transport-error", 0))),
    )
  )
})
