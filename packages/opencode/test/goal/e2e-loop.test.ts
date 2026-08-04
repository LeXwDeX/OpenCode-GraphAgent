import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { GoalLoop, GoalLoopJudgeLLM } from "@/goal/loop"
import { Goal } from "@/goal/goal"
import { GoalEvent } from "@/goal/events"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect, pollWithTimeout } from "../lib/effect"

// P2b: full-cycle Goal regression (D5). Drives set → idle → judge(continue) →
// continuation → idle → judge(done) → terminal event sequence, with the judge
// LLM scripted via the injected GoalLoopJudgeLLM (no network / Provider creds).
// Session / SessionPrompt / Provider are mocked; Goal / SessionStatus /
// EventV2Bridge are real so goal state, the fibers map, and the event bus are
// exercised end-to-end.

type CapturedEvent = { type: string; status?: string }

const captureEvents = (events: EventV2Bridge.Service["Service"]) =>
  Effect.gen(function* () {
    const seen: CapturedEvent[] = []
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        const goal = (event.data as { goal?: { status?: string } }).goal
        seen.push({ type: event.type, status: goal?.status })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return seen
  })

// Scripted assistant response — afterIdle extracts its text as the judge input.
const assistantText = "I have made progress on the feature."
// GoalLoop.init forks the idle-event subscription (loop.ts Effect.forkScoped).
// No observable latch exists for stream-subscription registration, so the only
// sync point before publishing the first idle event is this bounded fork-window
// wait. Kept intentionally: replacing it needs a subscribe-ready signal in
// EventV2Bridge (production change, out of scope for test hygiene).
const SUBSCRIPTION_SETTLE_MS = 200
const mkAssistant = () =>
  ({
    info: { role: "assistant", time: { created: Date.now() } },
    parts: [{ type: "text", text: assistantText }],
  }) as never

describe("GoalLoop end-to-end — continue → done lifecycle (P2b)", () => {
  // Per-test mutable mock state (each it.instance runs in its own scope, but
  // these closures are shared across the single test below — fine since the
  // test serializes the two judge calls).
  let judgeCalls = 0
  const promptCalls: { noReply?: boolean; text: string }[] = []

  const reset = () => {
    judgeCalls = 0
    promptCalls.length = 0
  }

  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  } as never)
  const promptMock = Layer.succeed(SessionPrompt.Service, {
    prompt: (input: { noReply?: boolean; parts?: Array<{ type: string; text: string }> }) =>
      Effect.sync(() => {
        promptCalls.push({
          noReply: input.noReply,
          text: input.parts?.map((p) => p.text).join("\n") ?? "",
        })
        return undefined as never
      }),
  } as never)
  const providerMock = Layer.succeed(Provider.Service, {} as never)
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          // First judge call → continue; second → done.
          return judgeCalls === 1
            ? JSON.stringify({ done: false, reason: "more steps needed" })
            : JSON.stringify({ done: true, reason: "feature shipped" })
        }),
    }),
  )

  const e2eLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(e2eLayer)

  it.instance("set → continue → continuation → done → cleared, scripted judge", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)

      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      // Let the idle subscription finish wiring (InstanceState is built on the
      // first init) before publishing, so the first idle event is not missed.
      yield* Effect.sleep(SUBSCRIPTION_SETTLE_MS)

      // ── Turn 1: idle → judge(continue) → continuation prompt ──
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 1 ? true : undefined)),
        "judge call 1 (continue) never fired",
        "5 seconds",
      )

      const after1 = yield* goal.load(sid)
      expect(after1?.status).toBe("active")
      expect(Number(after1?.turns_used)).toBe(1)
      // A continuation prompt was injected (not a noReply), carrying the goal.
      expect(promptCalls.some((p) => !p.noReply)).toBe(true)

      // ── Turn 2: idle → judge(done) → terminal event sequence ──
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 2 ? true : undefined)),
        "judge call 2 (done) never fired",
        "5 seconds",
      )

      const types = seen.map((e) => e.type)
      // Terminal contract: goal.updated(done) then goal.cleared, exactly once.
      const doneUpdates = seen.filter((e) => e.type === GoalEvent.Updated.type && e.status === "done")
      expect(doneUpdates.length).toBe(1)
      expect(types).toContain(GoalEvent.Cleared.type)
      // Row deleted after the terminal sequence.
      const loaded = yield* goal.load(sid)
      expect(loaded).toBeUndefined()
    }),
  )
})

// D1 (hooks-goal-completeness): a continuation dispatch failure must surface as a
// recoverable paused state, not a silent stall. Reuses the e2e harness with a
// prompt mock that always fails — the only prompt in this flow is the
// continuation after judge(continue), so it fails and exercises the catchCause
// → pauseAndPublish branch added in loop.ts.
describe("GoalLoop — continuation dispatch failure → recoverable pause (D1)", () => {
  let judgeCalls = 0
  const reset = () => {
    judgeCalls = 0
  }

  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  } as never)
  // Always-failing prompt — simulates provider fault / session write error.
  const promptFailMock = Layer.succeed(SessionPrompt.Service, {
    prompt: () => Effect.fail(new Error("continuation provider down")),
  } as never)
  const providerMock = Layer.succeed(Provider.Service, {} as never)
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ done: false, reason: "more steps needed" })
        }),
    }),
  )
  const failLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptFailMock),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(failLayer)

  // 1.2 — continuation prompt fails → goal transitions to paused with a reason
  // and a goal.updated(paused) event; afterIdle does not propagate the error.
  it.instance("continuation prompt 失败 → goal paused + reason + 事件发布", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      // Let the idle subscription wire (InstanceState builds on first init).
      yield* Effect.sleep(SUBSCRIPTION_SETTLE_MS)

      // idle → judge(continue) → continuation prompt fails → catchCause → pause
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return g?.status === "paused" ? true : undefined
        }),
        "goal never transitioned to paused after continuation failure",
        "5 seconds",
      )

      const paused = yield* goal.load(sid)
      expect(paused?.status).toBe("paused")
      expect(String(paused?.paused_reason)).toContain("continuation dispatch failed")
      // goal.updated(paused) published (SSE/TUI visible)
      expect(seen.some((e) => e.type === GoalEvent.Updated.type && e.status === "paused")).toBe(true)
      // The continuation was actually attempted: judge ran, turns_used advanced.
      expect(judgeCalls).toBeGreaterThanOrEqual(1)
      expect(Number(paused?.turns_used)).toBe(1)
    }),
  )

  // 1.3 — after the failure-induced pause, /goal resume restores active and
  // preserves the turns_used budget (resume must not silently grant a fresh budget).
  it.instance("paused 后 resume 恢复 active，turns_used 保留", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.sleep(SUBSCRIPTION_SETTLE_MS)
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return g?.status === "paused" ? true : undefined
        }),
        "goal never transitioned to paused before resume",
        "5 seconds",
      )
      const before = yield* goal.load(sid)
      const turnsBefore = Number(before?.turns_used)

      const resumed = yield* goal.resume(sid)
      expect(resumed?.status).toBe("active")
      expect(Number(resumed?.turns_used)).toBe(turnsBefore) // budget preserved, not reset
      expect(resumed?.paused_reason).toBeUndefined()
    }),
  )
})
