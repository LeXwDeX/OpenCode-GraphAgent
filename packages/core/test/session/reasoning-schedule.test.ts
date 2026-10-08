import { expect, test } from "bun:test"
import { Deferred, Effect, Scope } from "effect"
import { makeRewriteScheduler } from "../../src/session/reasoning-distillation/schedule"

const run = <A>(body: (scope: Scope.Scope) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* body(yield* Scope.Scope)
      }),
    ),
  )

const enabled = Effect.succeed(true)

test("a barrier collects adopted results once and leaves nothing pending", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 1_000 })
      for (const key of ["a", "b"])
        yield* scheduler.submit({
          sessionID: "s",
          key,
          enabled,
          run: (canAdopt) => canAdopt.pipe(Effect.map((ok) => (ok ? `adopted-${key}` : undefined))),
        })
      expect((yield* scheduler.settle("s")).toSorted()).toEqual(["adopted-a", "adopted-b"])
      expect(scheduler.pending("s")).toBe(0)
      expect(yield* scheduler.settle("s")).toEqual([])
      expect(yield* scheduler.settle("other")).toEqual([])
    }),
  ))

test("a barrier waits for in-flight work finishing within the settle window", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 2_000 })
      const started = yield* Deferred.make<void>()
      yield* scheduler.submit({
        sessionID: "s",
        key: "a",
        enabled,
        run: (canAdopt) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Effect.sleep("30 millis")
            return (yield* canAdopt) ? "late-but-in-window" : undefined
          }),
      })
      yield* Deferred.await(started)
      expect(yield* scheduler.settle("s")).toEqual(["late-but-in-window"])
    }),
  ))

test("work still organizing after the window is sealed, interrupted and can never adopt", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 20 })
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      let captured: Effect.Effect<boolean> | undefined
      yield* scheduler.submit({
        sessionID: "s",
        key: "slow",
        enabled,
        run: (canAdopt) =>
          Effect.gen(function* () {
            captured = canAdopt
            yield* Deferred.succeed(started, undefined)
            yield* Effect.never
            return "never"
          }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      })
      yield* Deferred.await(started)
      const begun = performance.now()
      expect(yield* scheduler.settle("s")).toEqual([])
      expect(performance.now() - begun).toBeLessThan(1_000)
      yield* Deferred.await(interrupted)
      expect(yield* captured!).toBe(false)
      expect(scheduler.pending("s")).toBe(0)
    }),
  ))

test("an adoption that passed the seal check is awaited and included", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 0 })
      const adopting = yield* Deferred.make<void>()
      yield* scheduler.submit({
        sessionID: "s",
        key: "a",
        enabled,
        run: (canAdopt) =>
          Effect.gen(function* () {
            if (!(yield* canAdopt)) return undefined
            yield* Deferred.succeed(adopting, undefined)
            yield* Effect.sleep("30 millis")
            return "committed"
          }),
      })
      yield* Deferred.await(adopting)
      expect(yield* scheduler.settle("s")).toEqual(["committed"])
    }),
  ))

test("a zero window seals pending work immediately", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 0, concurrency: 1 })
      const release = yield* Deferred.make<void>()
      const results: (string | undefined)[] = []
      for (const key of ["a", "b"])
        yield* scheduler.submit({
          sessionID: "s",
          key,
          enabled,
          run: (canAdopt) =>
            Effect.gen(function* () {
              yield* Deferred.await(release)
              const value = (yield* canAdopt) ? key : undefined
              results.push(value)
              return value
            }),
        })
      expect(yield* scheduler.settle("s")).toEqual([])
      yield* Deferred.succeed(release, undefined)
      yield* Effect.sleep("20 millis")
      expect(results.every((value) => value === undefined)).toBe(true)
    }),
  ))

test("disabled work is not scheduled and disabling later blocks adoption", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 1_000 })
      let ran = false
      yield* scheduler.submit({
        sessionID: "s",
        key: "off",
        enabled: Effect.succeed(false),
        run: () => Effect.sync(() => (ran = true)).pipe(Effect.as("x")),
      })
      expect(ran).toBe(false)
      expect(scheduler.pending("s")).toBe(0)
      let on = true
      const started = yield* Deferred.make<void>()
      const proceed = yield* Deferred.make<void>()
      yield* scheduler.submit({
        sessionID: "s",
        key: "toggled",
        enabled: Effect.sync(() => on),
        run: (canAdopt) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(proceed)
            return (yield* canAdopt) ? "adopted" : undefined
          }),
      })
      yield* Deferred.await(started)
      on = false
      yield* Deferred.succeed(proceed, undefined)
      expect(yield* scheduler.settle("s")).toEqual([])
    }),
  ))

test("concurrency is bounded per session, duplicates are ignored and sessions are independent", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 2_000, concurrency: 2 })
      let active = 0
      let peak = 0
      let calls = 0
      const job = (sessionID: string, key: string) =>
        scheduler.submit({
          sessionID,
          key,
          enabled,
          run: () =>
            Effect.gen(function* () {
              calls++
              active++
              peak = Math.max(peak, active)
              yield* Effect.sleep("15 millis")
              active--
              return `${sessionID}:${key}`
            }),
        })
      for (const key of ["a", "b", "c", "d"]) yield* job("s", key)
      yield* job("s", "a")
      yield* job("t", "a")
      expect((yield* scheduler.settle("s")).toSorted()).toEqual(["s:a", "s:b", "s:c", "s:d"])
      expect(yield* scheduler.settle("t")).toEqual(["t:a"])
      expect(calls).toBe(5)
      expect(peak).toBeLessThanOrEqual(3)
    }),
  ))

test("finished work that adopted nothing is dropped without waiting for a barrier", () =>
  run((scope) =>
    Effect.gen(function* () {
      const scheduler = makeRewriteScheduler<string>(scope, { settleMs: () => 1_000 })
      const done = yield* Deferred.make<void>()
      yield* scheduler.submit({
        sessionID: "s",
        key: "skipped",
        enabled,
        run: () => Deferred.succeed(done, undefined).pipe(Effect.as(undefined)),
      })
      yield* scheduler.submit({ sessionID: "s", key: "adopted", enabled, run: () => Effect.succeed("kept") })
      yield* Deferred.await(done)
      yield* Effect.sleep("10 millis")
      expect(scheduler.pending("s")).toBe(1)
      expect(yield* scheduler.settle("s")).toEqual(["kept"])
      expect(scheduler.pending("s")).toBe(0)
    }),
  ))
