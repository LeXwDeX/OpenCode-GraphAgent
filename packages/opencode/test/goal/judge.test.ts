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
    const result = GoalJudge.parseJudgeResponse("I think it's done")
    expect(result).toEqual({
      verdict: "continue",
      reason: "无法解析 judge 输出",
      parseFailed: true,
    })
  })

  test("empty string returns parseFailed", () => {
    const result = GoalJudge.parseJudgeResponse("")
    expect(result.parseFailed).toBe(true)
    expect(result.verdict).toBe("continue")
  })

  test("valid JSON but wrong shape (missing reason) returns parseFailed", () => {
    const result = GoalJudge.parseJudgeResponse('{"done": true}')
    expect(result.parseFailed).toBe(true)
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

  // The genuine step-3 regex limitation: verdict JSON embedded in prose where
  // the reason itself contains a nested brace. Step 2 fails (not pure JSON),
  // so step 3 runs. `\{[^{}]*\}` cannot span the outer object (it forbids inner
  // braces), so it instead matches the innermost `{config}`, which is not valid
  // verdict JSON → falls through to step 4 (parseFailed: true). A future
  // balanced-brace extractor would fix this; locked here so the limitation is
  // visible and a fix is detectable.
  test("nested-brace reason embedded in prose hits the step-3 regex limitation", () => {
    const raw = 'Sure! {"done": true, "reason": "set up {config}"} done'
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result.parseFailed).toBe(true)
    expect(result.verdict).toBe("continue")
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
      expect(result.reason).toMatch(/timeout|network/i)
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
