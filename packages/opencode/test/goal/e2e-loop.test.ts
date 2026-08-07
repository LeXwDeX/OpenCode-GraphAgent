import { describe, expect } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { GoalLoop, GoalLoopJudgeLLM } from "@/goal/loop"
import { Goal } from "@/goal/goal"
import { GoalEvent } from "@/goal/events"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
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

// A user-only message window — no assistant turn exists. Drives afterIdle into
// the "no lastAssistant" branch (loop.ts branch 1 → visible pause).
const mkUser = () =>
  ({
    info: { role: "user", time: { created: Date.now() } },
    parts: [{ type: "text", text: "继续推进" }],
  }) as never

// An assistant turn that produced only tool calls (no text part). afterIdle's
// responseText filter (`p.type === "text"`) yields "" → the synthetic
// continue verdict skips the judge entirely (loop.ts branch 2 → no stall).
const mkAssistantTools = () =>
  ({
    info: { role: "assistant", time: { created: Date.now() } },
    parts: [{ type: "tool-call", toolCallId: "1", toolName: "run", input: {} }],
  }) as never

// Prompt mock that records every call (noReply flag + joined text) for branch
// assertions. Resolves void — these tests never drive a real agent turn from
// the mock; the goal state and event captures are the observable contract.
const recordingPrompt = (sink: { noReply?: boolean; text: string }[]) =>
  Layer.succeed(SessionPrompt.Service, {
    prompt: (input: { noReply?: boolean; parts?: Array<{ type: string; text: string }> }) =>
      Effect.sync(() => {
        sink.push({
          noReply: input.noReply,
          text: input.parts?.map((p) => p.text).join("\n") ?? "",
        })
        return undefined as never
      }),
  } as never)

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

// ── Stall-prevention branch coverage ───────────────────────────────────
//
// afterIdle has four historically-silent stall paths that now surface as
// visible pauses or documented continuations. Each test drives exactly one
// branch via the GoalLoopJudgeLLM injection point + mocked Session /
// SessionPrompt, with Goal / SessionStatus / EventV2Bridge real so goal
// state, the fibers map, and the event bus are exercised end-to-end.

// Branch 1 (loop.ts): no assistant message in the last-20 window → the loop
// used to bare-return and leave the goal permanently "active" with no
// progress. It now publishes a visible pause + a noReply prompt.
describe("GoalLoop — no assistant in window → visible pause (branch 1)", () => {
  const promptCalls: { noReply?: boolean; text: string }[] = []
  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkUser()]),
  } as never)
  const providerMock = Layer.succeed(Provider.Service, {} as never)
  // The judge is unreachable on this path — branch 1 returns before it.
  // Die loudly so a regression that reaches the judge fails the test.
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({ call: () => Effect.die("branch 1 must not reach the judge") }),
  )

  const branchLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(recordingPrompt(promptCalls)),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(branchLayer)

  it.instance("无 assistant 回复 → goal paused + 可见暂停提示 + noReply prompt", () =>
    Effect.gen(function* () {
      promptCalls.length = 0
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
        "branch 1 never paused the goal",
        "5 seconds",
      )

      const paused = yield* goal.load(sid)
      expect(paused?.status).toBe("paused")
      expect(String(paused?.paused_reason)).toContain("无 assistant 回复")
      // Visible pause: a noReply prompt was injected (not a bare return).
      expect(promptCalls.some((p) => p.noReply)).toBe(true)
    }),
  )
})

// Branch 2 (loop.ts): the last assistant turn produced no text (pure tool
// calls / reasoning-only). The loop now synthesizes a "continue" verdict and
// skips the judge, instead of stalling. Proves the synthetic-continue path
// advances the turn budget without invoking the judge LLM.
describe("GoalLoop — empty assistant text → synthetic continue, no stall (branch 2)", () => {
  let judgeCalls = 0
  const promptCalls: { noReply?: boolean; text: string }[] = []
  const reset = () => {
    judgeCalls = 0
    promptCalls.length = 0
  }

  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkAssistantTools()]),
  } as never)
  const providerMock = Layer.succeed(Provider.Service, {} as never)
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ done: false, reason: "more steps" })
        }),
    }),
  )

  const branchLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(recordingPrompt(promptCalls)),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(branchLayer)

  it.instance("纯工具调用 → 跳过 judge，合成 continue，turns_used 推进不 stall", () =>
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
      // The synthetic continue dispatches a continuation prompt (non-noReply).
      // Poll on the dispatched prompt since turns_used is set just before it.
      yield* pollWithTimeout(
        Effect.sync(() => (promptCalls.some((p) => !p.noReply) ? true : undefined)),
        "branch 2 never dispatched a continuation",
        "5 seconds",
      )

      // Judge was never invoked — the empty-text short-circuit took over.
      expect(judgeCalls).toBe(0)
      const g = yield* goal.load(sid)
      expect(g?.status).toBe("active")
      expect(Number(g?.turns_used)).toBe(1)
    }),
  )
})

// Branch 3 (loop.ts): after the judge call returns, the session status is no
// longer idle (5-30s of judge latency). The loop now pauses visibly instead of
// bare-returning. Status is pre-set to busy so afterIdle's post-judge status
// check observes a non-idle state; the raw idle-event publish drives afterIdle
// without clearing the stored busy entry.
describe("GoalLoop — status changed during judge → visible pause (branch 3)", () => {
  let judgeCalls = 0
  const promptCalls: { noReply?: boolean; text: string }[] = []
  const reset = () => {
    judgeCalls = 0
    promptCalls.length = 0
  }

  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  } as never)
  const providerMock = Layer.succeed(Provider.Service, {} as never)
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ done: false, reason: "more steps" })
        }),
    }),
  )

  const branchLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(recordingPrompt(promptCalls)),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    // provideMerge (not provide): the test body yields SessionStatus.Service to
    // pre-set busy, and afterIdle must read that SAME instance — a consumed
    // (non-merged) SessionStatus would be invisible to the test body AND could
    // diverge from the one afterIdle uses.
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(branchLayer)

  it.instance("judge 期间 status 变非 idle → goal paused + 可见提示", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const status = yield* SessionStatus.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      // Make the session non-idle so afterIdle's post-judge status check sees
      // busy. The raw idle-event publish below drives afterIdle WITHOUT
      // touching the status map, so the busy entry persists.
      yield* status.set(sid, { type: "busy" })
      yield* Effect.sleep(SUBSCRIPTION_SETTLE_MS)

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return g?.status === "paused" ? true : undefined
        }),
        "branch 3 never paused the goal",
        "5 seconds",
      )

      expect(judgeCalls).toBeGreaterThanOrEqual(1)
      const paused = yield* goal.load(sid)
      expect(paused?.status).toBe("paused")
      expect(String(paused?.paused_reason)).toContain("状态变化")
      expect(promptCalls.some((p) => p.noReply)).toBe(true)
    }),
  )
})

// Branch 4 (loop.ts): the continuation dispatch fails with an INTERRUPT cause
// (user pressed ESC mid-dispatch). The loop logs and returns WITHOUT pausing,
// relying on the session always re-emitting idle (SessionStatus.set publishes
// idle unconditionally) to fork a fresh afterIdle — whose shouldPreempt guard
// handles the user's newer message. Pausing here would race that replacement
// fiber. Asserts: no pause published, goal stays active, and a second idle
// event re-drives the loop (proving it is not stalled by the dropped interrupt).
describe("GoalLoop — continuation interrupted → no pause, goal stays active (branch 4)", () => {
  let judgeCalls = 0
  const reset = () => {
    judgeCalls = 0
  }

  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  } as never)
  // Continuation dispatch fails with an INTERRUPT cause — simulates user ESC
  // mid-dispatch. catchCause sees hasInterrupts → branch 4 (log + return). The
  // cause is held in `interruptCause` so each instance below covers a different
  // fiber-id shape: a DEFINED id (Cause.interrupt(0)) and Cause.interrupt()'s
  // undefined id — the F1 miss case that Cause.interruptors silently drops and
  // the old interruptors().size check misclassified as a dispatch failure.
  let interruptCause: Cause.Cause<never> = Cause.interrupt(0)
  const promptInterruptMock = Layer.succeed(SessionPrompt.Service, {
    prompt: () => Effect.failCause(interruptCause),
  } as never)
  const providerMock = Layer.succeed(Provider.Service, {} as never)
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ done: false, reason: "more steps" })
        }),
    }),
  )

  const branchLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptInterruptMock),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(branchLayer)

  it.instance("continuation 被中断（defined fiber id）→ 不暂停，goal 保持 active，后续 idle 重新驱动", () =>
    Effect.gen(function* () {
      reset()
      interruptCause = Cause.interrupt(0)
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.sleep(SUBSCRIPTION_SETTLE_MS)

      // Turn 1: idle → judge(continue) → continuation fails with interrupt →
      // branch 4: log + return, NO pause.
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      // turns_used advancing proves updateAfterJudge ran (just before the
      // failed continuation), so the cycle reached the dispatch step.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return Number(g?.turns_used) >= 1 ? true : undefined
        }),
        "branch 4: turns_used never advanced",
        "5 seconds",
      )

      const afterInterrupt = yield* goal.load(sid)
      expect(afterInterrupt?.status).toBe("active") // NOT paused
      expect(afterInterrupt?.paused_reason).toBeUndefined()
      // No goal.updated(paused) event was published by branch 4.
      expect(seen.some((e) => e.type === GoalEvent.Updated.type && e.status === "paused")).toBe(false)

      // Turn 2: a fresh idle event re-drives afterIdle — the contract branch 4
      // relies on (SessionStatus always re-emits idle). The loop must NOT be
      // stalled by the dropped interrupt; judge fires a second time.
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 2 ? true : undefined)),
        "branch 4: loop did not re-drive on second idle",
        "5 seconds",
      )
    }),
  )

  // F1: the same interrupt contract must hold when the cause carries NO
  // defined fiber id (Cause.interrupt() → fiberId undefined). The old
  // interruptors().size check dropped such reasons (causeFilterInterruptors
  // skips undefined ids), misclassifying the interrupt as a dispatch failure
  // and spuriously pausing. hasInterrupts is structural and catches it.
  it.instance("continuation 被中断（undefined fiber id, F1 miss case）→ 同样不暂停，goal 保持 active", () =>
    Effect.gen(function* () {
      reset()
      interruptCause = Cause.interrupt()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.sleep(SUBSCRIPTION_SETTLE_MS)

      // idle → judge(continue) → continuation fails with an anonymous interrupt
      // → branch 4: log + return, NO pause (the F1 fix; old code paused here).
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return Number(g?.turns_used) >= 1 ? true : undefined
        }),
        "branch 4 (undefined id): turns_used never advanced",
        "5 seconds",
      )

      const afterInterrupt = yield* goal.load(sid)
      expect(afterInterrupt?.status).toBe("active") // NOT paused
      expect(afterInterrupt?.paused_reason).toBeUndefined()
      expect(seen.some((e) => e.type === GoalEvent.Updated.type && e.status === "paused")).toBe(false)
    }),
  )
})
