import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Schema } from "effect"
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

  it.instance("DAG cannot claim before a Goal fenced commit finishes", () =>
    Effect.gen(function* () {
      const lease = yield* SessionAutomationLease.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "goal-1" }
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let dagClaimedBeforeCommit = false

      yield* lease.register(sessionID, goal)
      const token = Option.getOrThrow(yield* lease.claim(sessionID, goal))
      const commit = yield* lease.use(
        token,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      ).pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      const dag = yield* Effect.gen(function* () {
        yield* lease.register(sessionID, { kind: "dag", id: "dag-1" })
        dagClaimedBeforeCommit = Option.isSome(yield* lease.claim(sessionID, { kind: "dag" }))
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(dagClaimedBeforeCommit).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(commit)
      yield* Fiber.join(dag)
      expect(dagClaimedBeforeCommit).toBe(true)
    }),
  )

  it.instance("handoff activates outside the fence", () =>
    Effect.gen(function* () {
      const lease = yield* SessionAutomationLease.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "goal-1" }
      const activationEntered = yield* Deferred.make<void>()
      const releaseActivation = yield* Deferred.make<void>()

      yield* lease.register(sessionID, goal)
      const token = Option.getOrThrow(yield* lease.claim(sessionID, goal))
      const handoff = yield* lease.handoff(
        token,
        Effect.succeed(Option.some({
          activate: Deferred.succeed(activationEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseActivation)),
          ),
          result: Effect.void,
          abort: Effect.void,
        })),
      ).pipe(Effect.forkChild)

      yield* Deferred.await(activationEntered)
      yield* lease.register(sessionID, { kind: "dag", id: "dag-1" }).pipe(
        Effect.timeoutOrElse({
          duration: "250 millis",
          orElse: () => Effect.die("activation still held the automation fence"),
        }),
        Effect.ensuring(Deferred.succeed(releaseActivation, undefined)),
      )
      expect(Option.isSome(yield* lease.claim(sessionID, { kind: "dag" }))).toBe(true)
      yield* Fiber.join(handoff)
    }),
  )

  it.instance("handoff activation survives interruption", () =>
    Effect.gen(function* () {
      const lease = yield* SessionAutomationLease.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "goal-1" }
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let activated = false
      let aborted = false

      yield* lease.register(sessionID, goal)
      const token = Option.getOrThrow(yield* lease.claim(sessionID, goal))
      const handoff = yield* lease.handoff(
        token,
        Effect.succeed(Option.some({
          activate: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.sync(() => (activated = true))),
          ),
          result: Effect.void,
          abort: Effect.sync(() => (aborted = true)),
        })),
      ).pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      const interrupted = yield* Fiber.interrupt(handoff).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupted)
      expect({ activated, aborted }).toEqual({ activated: true, aborted: false })
    }),
  )

  it.instance("handoff interruption cancels a blocked preparation and releases the fence", () =>
    Effect.gen(function* () {
      const lease = yield* SessionAutomationLease.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "goal-1" }
      const entered = yield* Deferred.make<void>()
      let finalized = false

      yield* lease.register(sessionID, goal)
      const token = Option.getOrThrow(yield* lease.claim(sessionID, goal))
      const handoff = yield* lease.handoff(
        token,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => (finalized = true))),
        ),
      ).pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      yield* Fiber.interrupt(handoff)
      yield* lease.register(sessionID, { kind: "dag", id: "dag-1" }).pipe(
        Effect.timeoutOrElse({
          duration: "250 millis",
          orElse: () => Effect.die("interrupted preparation retained the automation fence"),
        }),
      )
      expect(finalized).toBe(true)
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
