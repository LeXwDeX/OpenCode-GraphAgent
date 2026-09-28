import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Scope } from "effect"
import { makeTurnScheduler } from "../../src/session/reasoning-distillation/schedule"

const submit = (
  sessionID: string,
  turnID: string,
  work: Effect.Effect<void, unknown>,
  enabled = Effect.succeed(true),
) => ({
  sessionID,
  turnID,
  work,
  enabled,
})

test("first turn returns immediately; later turns serialize and duplicates are ignored", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const schedule = makeTurnScheduler(yield* Scope.Scope)
        const calls: string[] = []
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const done = yield* Deferred.make<void>()
        yield* schedule(
          submit(
            "s",
            "1",
            Effect.gen(function* () {
              calls.push("start")
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              calls.push("end")
            }),
          ),
        )
        yield* Deferred.await(started)
        yield* schedule(
          submit(
            "s",
            "2",
            Effect.gen(function* () {
              calls.push("second")
              yield* Deferred.succeed(done, undefined)
            }),
          ),
        )
        yield* schedule(
          submit(
            "s",
            "2",
            Effect.sync(() => calls.push("duplicate")),
          ),
        )
        expect(calls).toEqual(["start"])
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(done)
        expect(calls).toEqual(["start", "end", "second"])
      }),
    ),
  )
})

test("background proposal and judgment can complete adoption after submission returns", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const schedule = makeTurnScheduler(yield* Scope.Scope)
        const proposalStarted = yield* Deferred.make<void>()
        const releaseProposal = yield* Deferred.make<void>()
        const adopted = yield* Deferred.make<void>()
        const phases: string[] = []
        yield* schedule(
          submit(
            "s",
            "completed-turn",
            Effect.gen(function* () {
              phases.push("propose")
              yield* Deferred.succeed(proposalStarted, undefined)
              yield* Deferred.await(releaseProposal)
              phases.push("judge")
              phases.push("adopt")
              yield* Deferred.succeed(adopted, undefined)
            }),
          ),
        )
        yield* Deferred.await(proposalStarted)
        expect(phases).toEqual(["propose"])
        yield* Deferred.succeed(releaseProposal, undefined)
        yield* Deferred.await(adopted)
        expect(phases).toEqual(["propose", "judge", "adopt"])
      }),
    ),
  )
})

test("sessions proceed independently and queued work respects disable", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const schedule = makeTurnScheduler(yield* Scope.Scope)
        let enabled = false
        let ran = false
        const flag = Effect.sync(() => enabled)
        yield* schedule(
          submit(
            "off",
            "1",
            Effect.sync(() => {
              ran = true
            }),
            flag,
          ),
        )
        enabled = true
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* schedule(
          submit("a", "1", Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))), flag),
        )
        yield* Deferred.await(started)
        yield* schedule(
          submit(
            "a",
            "2",
            Effect.sync(() => {
              ran = true
            }),
            flag,
          ),
        )
        const other = yield* Deferred.make<void>()
        yield* schedule(submit("b", "1", Deferred.succeed(other, undefined), flag))
        yield* Deferred.await(other)
        expect(ran).toBe(false)
        enabled = false
        yield* Deferred.succeed(release, undefined)
        yield* Effect.yieldNow
        expect(ran).toBe(false)
      }),
    ),
  )
})

test("a failed turn leaves later work runnable", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const schedule = makeTurnScheduler(yield* Scope.Scope)
        const done = yield* Deferred.make<void>()
        yield* schedule(submit("s", "1", Effect.fail("auxiliary failed")))
        yield* schedule(submit("s", "2", Deferred.succeed(done, undefined)))
        yield* Deferred.await(done)
      }),
    ),
  )
})

test("closing the service scope interrupts background work", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const schedule = makeTurnScheduler(scope)
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      yield* schedule(
        submit(
          "s",
          "1",
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        ),
      )
      yield* Deferred.await(started)
      yield* Scope.close(scope, Exit.succeed(undefined))
      yield* Deferred.await(interrupted)
    }),
  )
})
