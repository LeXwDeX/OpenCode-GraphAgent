import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { SessionAutomationLease } from "@/session/automation-lease"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { EventV2Bridge } from "@/event-v2-bridge"
import { testEffect, pollWithTimeout } from "../lib/effect"

// S-3: the lease's dag-release re-trigger requires the real SessionStatus —
// the defaultLayer self-provides it, and the merged EventV2Bridge shares the
// memoized instance so the test can observe the re-triggered idle event.
const it = testEffect(
  SessionAutomationLease.defaultLayer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer)),
)

describe("SessionAutomationLease", () => {
  it.instance("DAG registration preempts Goal and invalidates its generation", () =>
    Effect.gen(function* () {
      const lease = yield* SessionAutomationLease.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "goal-1" }
      const dag = { kind: "dag" as const, id: "dag-1" }

      yield* lease.register(sessionID, goal)
      const goalToken = Option.getOrThrow(yield* lease.claim(sessionID, goal))
      yield* lease.register(sessionID, dag)

      expect(Option.isNone(yield* lease.use(goalToken, Effect.succeed("goal")))).toBe(true)
      const dagToken = Option.getOrThrow(yield* lease.claim(sessionID, { kind: "dag" }))
      expect(Option.getOrThrow(yield* lease.use(dagToken, Effect.succeed("dag")))).toBe("dag")
    }),
  )

  it.instance("Goal becomes owner again after the final DAG unregisters", () =>
    Effect.gen(function* () {
      const lease = yield* SessionAutomationLease.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "goal-1" }
      const first = { kind: "dag" as const, id: "dag-1" }
      const second = { kind: "dag" as const, id: "dag-2" }

      yield* lease.register(sessionID, goal)
      yield* lease.register(sessionID, first)
      yield* lease.register(sessionID, second)
      yield* lease.unregister(sessionID, first)
      expect(Option.isSome(yield* lease.claim(sessionID, { kind: "dag" }))).toBe(true)

      yield* lease.unregister(sessionID, second)
      expect(Option.isSome(yield* lease.claim(sessionID, goal))).toBe(true)
    }),
  )

  // S-3: the dag-release re-trigger must reach the real SessionStatus and
  // emit the idle status event — the re-trigger can never silently degrade
  // now that SessionStatus is a hard requirement of the lease layer.
  it.instance("S-3: a blocked goal claim is re-triggered through SessionStatus when the dag releases", () =>
    Effect.gen(function* () {
      const lease = yield* SessionAutomationLease.Service
      const events = yield* EventV2Bridge.Service
      const idleSessions: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          // event.data is untyped on the bus — decode it with the event
          // definition's data schema instead of asserting on it.
          if (event.type !== SessionStatus.Event.Status.type) return
          const payload = Schema.decodeUnknownSync(SessionStatus.Event.Status.data)(event.data)
          if (payload.status.type === "idle") idleSessions.push(String(payload.sessionID))
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const sessionID = SessionID.descending()
      yield* lease.register(sessionID, { kind: "dag", id: "dag-1" })
      // A goal claim rejected by the dag records the blocked obligation.
      expect(Option.isNone(yield* lease.claim(sessionID, { kind: "goal", id: "goal-1" }))).toBe(true)

      yield* lease.unregister(sessionID, { kind: "dag", id: "dag-1" })
      yield* pollWithTimeout(
        Effect.sync(() => (idleSessions.includes(String(sessionID)) ? true : undefined)),
        "dag release never re-triggered the idle status event",
        "5 seconds",
      )
    }),
  )
})
