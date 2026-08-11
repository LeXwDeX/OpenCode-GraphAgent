import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import { SessionAutomationLease } from "@/session/automation-lease"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(SessionAutomationLease.defaultLayer)

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
})
