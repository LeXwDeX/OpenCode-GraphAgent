export * as GoalJudge from "./judge"

import { Effect } from "effect"
import { GoalPrompts } from "./prompts"

export interface JudgeResult {
  readonly verdict: "done" | "continue"
  readonly reason: string
  readonly parseFailed: boolean
}

export function parseJudgeResponse(raw: string): JudgeResult {
  // Step 1: strip markdown fences
  const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim()

  // Step 2: try JSON.parse whole string
  try {
    const obj = JSON.parse(stripped)
    if (typeof obj.done === "boolean" && typeof obj.reason === "string")
      return { verdict: obj.done ? "done" : "continue", reason: obj.reason, parseFailed: false }
  } catch {}

  // Step 3: regex extract first {...}
  const match = stripped.match(/\{[^{}]*\}/)
  if (match) {
    try {
      const obj = JSON.parse(match[0])
      if (typeof obj.done === "boolean" && typeof obj.reason === "string")
        return { verdict: obj.done ? "done" : "continue", reason: obj.reason, parseFailed: false }
    } catch {}
  }

  // Step 4: parse failed
  return { verdict: "continue", reason: "无法解析 judge 输出", parseFailed: true }
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
    // count toward the pause budget (D5). Previously they returned
    // parseFailed: false, which reset consecutive_parse_failures and let a
    // flaky provider alternate bad-JSON and timeout indefinitely without
    // ever hitting MAX_CONSECUTIVE_PARSE_FAILURES. Returning parseFailed: true
    // feeds them through the same auto-pause path as parse failures, treating
    // "judge is unreliable" uniformly regardless of failure mode. The verdict
    // stays "continue" so a single transient blip does not stall the loop;
    // it only pauses after MAX_CONSECUTIVE_PARSE_FAILURES in a row.
    Effect.orElseSucceed((): JudgeResult => ({
      verdict: "continue",
      reason: "judge transport error (timeout or network) — counting toward pause budget",
      parseFailed: true,
    })),
  )
})
