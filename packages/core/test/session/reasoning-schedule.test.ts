import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Scope } from "effect"
import { makeTurnScheduler } from "../../src/session/reasoning-distillation/schedule"

test("default-off admission, first completion blocks, later turns run in order without blocking", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const schedule = makeTurnScheduler(yield* Scope.Scope)
        let enabled = false
        const calls: string[] = []
        const first = yield* Deferred.make<void>()
        const second = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const background = yield* Deferred.make<void>()
        const input = (turnID: string, work: Effect.Effect<void>) => ({
          sessionID: "s",
          turnID,
          enabled: Effect.sync(() => enabled),
          work,
        })
        yield* schedule(
          input(
            "off",
            Effect.sync(() => {
              calls.push("off")
            }),
          ),
        )
        expect(calls).toEqual([])
        enabled = true
        const sync = yield* schedule(
          input(
            "1",
            Effect.gen(function* () {
              calls.push("1-start")
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(first)
              calls.push("1-end")
            }),
          ),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        expect(calls).toEqual(["1-start"])
        expect(sync.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(first, undefined)
        yield* Fiber.join(sync)
        yield* schedule(
          input(
            "2",
            Effect.gen(function* () {
              calls.push("2-start")
              yield* Deferred.succeed(background, undefined)
              yield* Deferred.await(second)
              calls.push("2-end")
            }),
          ),
        )
        yield* Deferred.await(background)
        expect(calls).toEqual(["1-start", "1-end", "2-start"])
        const done = yield* Deferred.make<void>()
        yield* schedule(
          input(
            "3",
            Effect.gen(function* () {
              calls.push("3")
              yield* Deferred.succeed(done, undefined)
            }),
          ),
        )
        yield* schedule(
          input(
            "3",
            Effect.sync(() => {
              calls.push("duplicate")
            }),
          ),
        )
        yield* Deferred.succeed(second, undefined)
        yield* Deferred.await(done)
        expect(calls).toEqual(["1-start", "1-end", "2-start", "2-end", "3"])
      }),
    ),
  )
})

test("turn failure retains progress and disabled queued turns do no work", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const schedule = makeTurnScheduler(yield* Scope.Scope)
        let enabled = true
        const input = (turnID: string, work: Effect.Effect<void, unknown>) => ({
          sessionID: "s",
          turnID,
          enabled: Effect.sync(() => enabled),
          work,
        })
        yield* schedule(input("1", Effect.fail("auxiliary failed")))
        const busy = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* schedule(input("2", Deferred.succeed(busy, undefined).pipe(Effect.andThen(Deferred.await(release)))))
        yield* Deferred.await(busy)
        let ran = false
        yield* schedule(
          input(
            "3",
            Effect.sync(() => {
              ran = true
            }),
          ),
        )
        enabled = false
        yield* Deferred.succeed(release, undefined)
        yield* Effect.yieldNow
        expect(ran).toBe(false)
      }),
    ),
  )
})

test("reopened history with an adopted prior turn resumes background scheduling", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const schedule = makeTurnScheduler(yield* Scope.Scope)
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* schedule({
          sessionID: "restored",
          turnID: "next",
          previouslyDistilled: true,
          enabled: Effect.succeed(true),
          work: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        })
        yield* Deferred.await(started)
        yield* Deferred.succeed(release, undefined)
      }),
    ),
  )
})
