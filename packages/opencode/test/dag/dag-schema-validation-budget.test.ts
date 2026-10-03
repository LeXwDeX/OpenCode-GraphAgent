import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import {
  clearCaptureSlot,
  isCaptureValidationCurrent,
  registerCaptureSlot,
  validatePayloadAsync,
  settleCapturedOutput,
} from "@/dag/runtime/capture"
import { validateInWorker } from "@/dag/runtime/schema-validation"
import { SubmitResultTool } from "@/tool/submit_result"
import { DagStore } from "@opencode-ai/core/dag/store"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import type { Tool } from "@/tool/tool"

const session = "ses_schema_budget"
const pathological = "a".repeat(99_999) + "!"
const slow = { type: "string", pattern: "^(a|a?)+$" }
afterEach(() => clearCaptureSlot(session))

describe("bounded schema validation", () => {
  test("pathological regex keeps the host responsive and reports a resource deadline", async () => {
    const child = Bun.spawn(
      [process.execPath, new URL("./fixture/schema-validation-budget.ts", import.meta.url).pathname],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const watchdog = setTimeout(() => child.kill(), 3_000)
    try {
      expect(await child.exited).toBe(0)
      const data = JSON.parse(await new Response(child.stdout).text())
      expect(data.result.ok).toBe(false)
      expect(data.result.error).toContain("host resource budget")
      expect(data.beats).toBeGreaterThanOrEqual(5)
    } finally {
      clearTimeout(watchdog)
      child.kill()
    }
  })
  for (const [pattern, payload, ok] of [
    ["^(?=a)a+$", "aaa", true],
    ["^(a+)\\1$", "aaaa", true],
    ["^(a+)\\1$", "aaab", false],
    ["[", "a", false],
  ] as const)
    test(`preserves JavaScript pattern ${pattern} on ${payload}`, async () => {
      registerCaptureSlot(session, { type: "string", pattern })
      expect((await validatePayloadAsync(session, payload, new AbortController().signal)).ok).toBe(ok)
    })
  test("preserves null and provider JSON-string repair", async () => {
    registerCaptureSlot(session, { type: "null" })
    expect(await validatePayloadAsync(session, null, new AbortController().signal)).toMatchObject({
      ok: true,
      payload: null,
    })
    registerCaptureSlot(session, { type: "object", required: ["result"], properties: { result: { type: "integer" } } })
    expect(await validatePayloadAsync(session, '{"result":7}', new AbortController().signal)).toMatchObject({
      ok: true,
      payload: { result: 7 },
    })
  })
  test("preserves explicit character/item limits and review fingerprint settlement", async () => {
    registerCaptureSlot(session, { pattern: "a" })
    expect(await validatePayloadAsync(session, "a".repeat(100_001), new AbortController().signal)).toMatchObject({
      ok: false,
      error: "pattern validation is capped at 100000 characters, got 100001",
    })
    registerCaptureSlot(session, { uniqueItems: true })
    expect(
      await validatePayloadAsync(
        session,
        Array.from({ length: 1_001 }, (_, i) => i),
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: false, error: "uniqueItems validation is capped at 1000 items, got 1001" })
    const review = { verdict: "pass", implementation_fingerprint: "expected" }
    registerCaptureSlot(session, {
      type: "object",
      required: ["verdict", "implementation_fingerprint"],
      properties: { verdict: { enum: ["pass", "fail"] }, implementation_fingerprint: { type: "string" } },
    })
    const result = await validatePayloadAsync(session, review, new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(settleCapturedOutput(review, "different").kind).toBe("fail")
  })
  test("bounds non-regex validation and surfaces worker failures", async () => {
    const payload = Array.from({ length: 1_000 }, (_, i) => ({ prefix: Array.from({ length: 1_000 }, () => 0), i }))
    const result = await validateInWorker({ uniqueItems: true }, payload, new AbortController().signal, 100)
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error("expected deep-equality resource deadline")
    expect(result.error).toContain("host resource budget")
    expect(await validateInWorker({}, () => {}, new AbortController().signal)).toMatchObject({ ok: false })
    const a: Record<string, unknown> = {},
      b: Record<string, unknown> = {}
    a.next = a
    b.next = b
    const failed = await validateInWorker({ const: a }, b, new AbortController().signal)
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error("expected worker stack failure")
    expect(failed.error).toContain("worker failed")
    expect(await validateInWorker({ type: "null" }, null, new AbortController().signal)).toEqual({
      ok: true,
      payload: null,
    })
  })
  test("an unexpected silent worker exit still produces a finite deadline result", async () => {
    const url = URL.createObjectURL(new Blob(["onmessage = () => process.exit(0)"], { type: "text/javascript" }))
    try {
      const result = await validateInWorker({}, null, new AbortController().signal, 30, url)
      expect(result).toMatchObject({ ok: false })
      if (result.ok) throw new Error("expected worker exit deadline")
      expect(result.error).toContain("host resource budget")
    } finally {
      URL.revokeObjectURL(url)
    }
    expect(await validateInWorker({ type: "null" }, null, new AbortController().signal)).toEqual({
      ok: true,
      payload: null,
    })
  })
  test("cancellation releases the worker and same-session admission", async () => {
    registerCaptureSlot(session, slow)
    const abort = new AbortController()
    const pending = validatePayloadAsync(session, pathological, abort.signal)
    expect(await validatePayloadAsync(session, "a", abort.signal)).toMatchObject({
      ok: false,
      error: "schema validation is already running in this session",
    })
    abort.abort()
    expect(await pending).toMatchObject({ ok: false, error: "schema validation cancelled" })
    expect((await validatePayloadAsync(session, "a", new AbortController().signal)).ok).toBe(true)
  })
  test("clear and re-register reject an old async result even with the identical schema object", async () => {
    registerCaptureSlot(session, slow)
    const pending = validatePayloadAsync(session, pathological, new AbortController().signal)
    clearCaptureSlot(session)
    registerCaptureSlot(session, slow)
    expect(await pending).toMatchObject({ ok: false, notAvailable: true })
    const fresh = await validatePayloadAsync(session, "a", new AbortController().signal)
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) throw new Error(fresh.error)
    expect(isCaptureValidationCurrent(session, fresh)).toBe(true)
    clearCaptureSlot(session)
    registerCaptureSlot(session, slow)
    expect(isCaptureValidationCurrent(session, fresh)).toBe(false)
  })
})

const context = (abort: AbortSignal): Tool.Context => ({
  sessionID: SessionID.make(session),
  messageID: MessageID.ascending(),
  agent: "build",
  abort,
  messages: [],
  ask: () => Effect.void,
  metadata: () => Effect.void,
})
describe("submit_result worker persistence", () => {
  function layers(captured: unknown[]) {
    return Layer.mergeAll(
      Layer.mock(DagStore.Service, {
        setCapturedOutput: (_sessionID, payload) =>
          Effect.sync(() => {
            captured.push(payload)
          }),
      }),
      Layer.mock(Agent.Service, {
        get: () => Effect.succeed({ name: "build", mode: "all", permission: [], options: {} }),
      }),
      Layer.mock(Truncate.Service, { output: (content: string) => Effect.succeed({ content, truncated: false }) }),
    )
  }
  test("only successful validation persists, including null", async () => {
    const captured: unknown[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const tool = yield* SubmitResultTool
        const definition = yield* tool.init()
        registerCaptureSlot(session, slow)
        const timed = yield* definition.execute({ payload: pathological }, context(new AbortController().signal))
        expect(timed.output).toContain("host resource budget")
        expect(captured).toEqual([])
        registerCaptureSlot(session, { type: "null" })
        const valid = yield* definition.execute({ payload: null }, context(new AbortController().signal))
        expect(valid.metadata.captured).toBe(true)
        expect(captured).toEqual([null])
      }).pipe(Effect.provide(layers(captured))),
    )
  })
  test("Effect interruption terminates validation without persistence", async () => {
    const captured: unknown[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const tool = yield* SubmitResultTool
        const definition = yield* tool.init()
        registerCaptureSlot(session, slow)
        const fiber = yield* definition
          .execute({ payload: pathological }, context(new AbortController().signal))
          .pipe(Effect.forkChild)
        yield* Effect.sleep("30 millis")
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(captured).toEqual([])
        expect((yield* Effect.promise(() => validatePayloadAsync(session, "a", new AbortController().signal))).ok).toBe(
          true,
        )
      }).pipe(Effect.provide(layers(captured))),
    )
  })
  test("tool cancellation and same-schema slot replacement prevent capture", async () => {
    const captured: unknown[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const tool = yield* SubmitResultTool
        const definition = yield* tool.init()
        for (const cancel of [true, false]) {
          registerCaptureSlot(session, slow)
          const abort = new AbortController()
          const fiber = yield* definition
            .execute({ payload: pathological }, context(abort.signal))
            .pipe(Effect.forkChild)
          yield* Effect.sleep("30 millis")
          if (cancel) abort.abort()
          else {
            clearCaptureSlot(session)
            registerCaptureSlot(session, slow)
          }
          const result = yield* Fiber.join(fiber)
          expect(result.metadata.captured).not.toBe(true)
          expect(captured).toEqual([])
        }
      }).pipe(Effect.provide(layers(captured))),
    )
  })
})
