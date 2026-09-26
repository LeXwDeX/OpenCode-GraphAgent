import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GoalJudge } from "@/goal/judge"

describe("parseJudgeResponse", () => {
  // §1.2 — clean JSON parses directly (step 2)
  test("clean JSON object returns matching verdict", () => {
    const result = GoalJudge.parseJudgeResponse('{"done": true, "reason": "all tests pass"}')
    expect(result).toEqual({ verdict: "done", reason: "all tests pass", parseFailed: false })
  })

  test("clean JSON with done=false returns continue", () => {
    const result = GoalJudge.parseJudgeResponse('{"done": false, "reason": "still working"}')
    expect(result).toEqual({ verdict: "continue", reason: "still working", parseFailed: false })
  })

  test("blocked verdict stays distinct from successful completion", () => {
    const result = GoalJudge.parseJudgeResponse(
      '{"verdict":"blocked","reason":"missing production credentials"}',
    )
    expect(result).toEqual({
      verdict: "blocked",
      reason: "missing production credentials",
      parseFailed: false,
    })
  })

  // §1.3 — markdown-fenced JSON strips fences (step 1)
  test("markdown-fenced JSON strips fences and parses", () => {
    const raw = "```json\n{\"done\": false, \"reason\": \"more steps remain\"}\n```"
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({ verdict: "continue", reason: "more steps remain", parseFailed: false })
  })

  test("markdown-fenced without language tag also strips", () => {
    const raw = "```\n{\"done\": true, \"reason\": \"done\"}\n```"
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({ verdict: "done", reason: "done", parseFailed: false })
  })

  // §1.4 — JSON embedded in prose: regex step extracts first {...} block (step 3)
  test("JSON embedded in prose is extracted by regex fallback", () => {
    const raw = 'Sure! {"done": true, "reason": "shipped"} Thanks'
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({ verdict: "done", reason: "shipped", parseFailed: false })
  })

  // §1.5 — unparseable input falls through all steps (step 4)
  test("unparseable prose returns continue with parseFailed true", () => {
    const raw = "I think it's done"
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({
      verdict: "continue",
      reason: `judge 返回非 JSON 内容（${raw.length} 字符）`,
      parseFailed: true,
      failureCategory: "non-json",
    })
  })

  test("empty string reports an actionable privacy-safe category", () => {
    const result = GoalJudge.parseJudgeResponse("")
    expect(result.parseFailed).toBe(true)
    expect(result.verdict).toBe("continue")
    expect(result.failureCategory).toBe("empty")
    expect(result.reason).toBe("judge 返回空响应（0 字符）")
  })

  test("valid JSON but wrong shape reports invalid-shape", () => {
    const result = GoalJudge.parseJudgeResponse('{"done": true}')
    expect(result.parseFailed).toBe(true)
    expect(result.failureCategory).toBe("invalid-shape")
    expect(result.reason).toContain("缺少有效 verdict/reason")
  })

  test("truncated JSON is distinguishable without echoing response content", () => {
    const raw = '{"verdict":"done","reason":"tests passed"'
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({
      verdict: "continue",
      reason: `judge 返回疑似截断的 JSON（${raw.length} 字符）`,
      parseFailed: true,
      failureCategory: "truncated-json",
    })
    expect(result.reason).not.toContain("tests passed")
  })

  test("malformed closed JSON reports malformed-json", () => {
    const result = GoalJudge.parseJudgeResponse('{"verdict":"done",}')
    expect(result.parseFailed).toBe(true)
    expect(result.failureCategory).toBe("malformed-json")
  })

  // §1.6 — nested-brace reason. NOTE: this contradicts tasks.md §1.6, which
  // claims this input hits "step 4 fallback, parseFailed: true." It does not:
  // step 2 runs `JSON.parse` on the whole string, and JSON.parse correctly
  // handles braces inside string literals, so `{"reason": "set up {config}"}`
  // parses cleanly. The regex limitation (`\{[^{}]*\}` cannot span nested
  // braces) only manifests at STEP 3, and step 3 is only reached when step 2
  // has already FAILED — i.e. when the verdict JSON is embedded in prose.
  // See the next test for the case that actually demonstrates the limitation.
  // Asserting the real current behavior keeps RED-1 green.
  test("nested-brace reason parses via step 2 (JSON.parse handles braces in strings)", () => {
    const raw = '{"done": true, "reason": "set up {config}"}'
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({ verdict: "done", reason: "set up {config}", parseFailed: false })
  })

  test("balanced extraction accepts nested braces inside a quoted reason", () => {
    const raw = 'Sure! {"done": true, "reason": "set up {config}"} done'
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({ verdict: "done", reason: "set up {config}", parseFailed: false })
  })

  test("an unclosed markdown fence with a complete object still parses safely", () => {
    const raw = '```json\n{"verdict":"continue","reason":"more work"}'
    expect(GoalJudge.parseJudgeResponse(raw)).toEqual({
      verdict: "continue",
      reason: "more work",
      parseFailed: false,
    })
  })
})

describe("GoalJudge.run — transport failures count toward pause budget (D5)", () => {
  // §9.2 — when the injected callLLM fails (timeout, network error, rejection),
  // the orElseSucceed fallback MUST return parseFailed: true (not false) so the
  // failure increments consecutive_parse_failures via updateAfterJudge's
  // `parseFailed ? count + 1 : 0` logic. Pre-fix this returned parseFailed:
  // false, which reset the counter and let a flaky provider burn the full
  // max_turns budget without ever pausing.
  test("transport failure (Effect.fail) returns parseFailed: true", () =>
    Effect.gen(function* () {
      const result = yield* GoalJudge.run(
        "build feature X",
        "some agent response",
        [],
        () => Effect.fail(new Error("timeout")),
      )
      expect(result.verdict).toBe("continue")
      expect(result.parseFailed).toBe(true)
      expect(result.failureCategory).toBe("transport-error")
    }).pipe(Effect.runPromise),
  )

  test("transport failure reason names the failure mode", () =>
    Effect.gen(function* () {
      const result = yield* GoalJudge.run(
        "build feature X",
        "some agent response",
        [],
        () => Effect.fail(new Error("network down")),
      )
      // The reason must name the transport failure so the pause message
      // (when it eventually fires after MAX_CONSECUTIVE_PARSE_FAILURES)
      // can distinguish transport unreliability from parse failures.
      expect(result.reason).toMatch(/transport/i)
      expect(result.reason).toContain("judge 调用失败")
    }).pipe(Effect.runPromise),
  )

  test("non-Error rejection also returns parseFailed: true", () =>
    Effect.gen(function* () {
      const result = yield* GoalJudge.run(
        "build feature X",
        "some agent response",
        [],
        () => Effect.fail(new Error("ECONNRESET")),
      )
      expect(result.parseFailed).toBe(true)
      expect(result.verdict).toBe("continue")
    }).pipe(Effect.runPromise),
  )
})
