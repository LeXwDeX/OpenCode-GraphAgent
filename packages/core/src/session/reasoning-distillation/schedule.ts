import { Cause, Deferred, Duration, Effect, Fiber, Scope, Semaphore } from "effect"
import { ReasoningDistillationPolicy } from "./policy"

/**
 * A rewrite of one settled reasoning part. `run` organizes the part and adopts the result; it must validate
 * `canAdopt` inside the adoption transaction, which fails once the job is sealed.
 */
export type RewriteJob<A> = Readonly<{
  sessionID: string
  /** Stable part identity; a key is scheduled at most once until the next barrier collects it. */
  key: string
  enabled: Effect.Effect<boolean>
  run: (canAdopt: Effect.Effect<boolean>) => Effect.Effect<A | undefined, unknown>
}>

type Entry<A> = {
  phase: "organizing" | "adopting" | "done"
  sealed: boolean
  done: Deferred.Deferred<void>
  fiber?: Fiber.Fiber<void>
  adopted?: A
}

type SessionState<A> = { jobs: Map<string, Entry<A>>; lock: Semaphore.Semaphore }

/**
 * Per-session reasoning rewrite jobs with a send barrier.
 *
 * A part is first resent in the next provider request of its session. Hosts call `settle` immediately before building
 * that request: it waits for in-flight jobs up to the settle window, then seals and interrupts the rest. A sealed job
 * can never adopt, so each part is rewritten before its first resend or never, and earlier requests' cached prefixes
 * are never invalidated by a late rewrite. Work belongs to the given application scope.
 */
export const makeRewriteScheduler = <A>(
  scope: Scope.Scope,
  options: { settleMs: () => number; concurrency?: number },
) => {
  const sessions = new Map<string, SessionState<A>>()
  const concurrency = options.concurrency ?? ReasoningDistillationPolicy.calls.maxConcurrentPerSession

  const submit = Effect.fn("ReasoningRewrite.submit")(function* (job: RewriteJob<A>) {
    if (!(yield* job.enabled)) return
    let state = sessions.get(job.sessionID)
    if (!state) {
      state = { jobs: new Map(), lock: Semaphore.makeUnsafe(concurrency) }
      sessions.set(job.sessionID, state)
    }
    if (state.jobs.has(job.key)) return
    const entry: Entry<A> = { phase: "organizing", sealed: false, done: Deferred.makeUnsafe<void>() }
    state.jobs.set(job.key, entry)
    // The seal check and the phase change are one synchronous step: settle either sees `adopting` and waits for the
    // commit, or seals first and the adoption transaction rejects.
    const canAdopt = job.enabled.pipe(
      Effect.flatMap((enabled) =>
        Effect.sync(() => {
          if (!enabled || entry.sealed) return false
          entry.phase = "adopting"
          return true
        }),
      ),
    )
    entry.fiber = yield* state.lock
      .withPermit(
        Effect.gen(function* () {
          if (entry.sealed || !(yield* job.enabled)) return
          entry.adopted = yield* job.run(canAdopt)
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : Effect.logWarning("reasoning rewrite failed; retaining current history"),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            entry.phase = "done"
            // Only adopted results matter to the next barrier; drop everything else now so sessions that never send
            // again do not retain finished work.
            if (entry.adopted !== undefined || state.jobs.get(job.key) !== entry) return
            state.jobs.delete(job.key)
            if (state.jobs.size === 0 && sessions.get(job.sessionID) === state) sessions.delete(job.sessionID)
          }).pipe(Effect.andThen(Deferred.succeed(entry.done, undefined))),
        ),
        Effect.forkIn(scope),
      )
  })

  /**
   * Barrier before a provider request of this session. Returns the results adopted since the previous barrier so the
   * caller can update history it already holds in memory. Keep results small (identities): they are retained until the
   * session's next barrier.
   */
  const settle = Effect.fn("ReasoningRewrite.settle")(function* (sessionID: string) {
    const state = sessions.get(sessionID)
    if (!state || state.jobs.size === 0) return [] as A[]
    const entries = [...state.jobs.entries()]
    const waitMs = options.settleMs()
    const started = performance.now()
    if (waitMs > 0 && entries.some(([, entry]) => entry.phase !== "done"))
      yield* Effect.forEach(entries, ([, entry]) => Deferred.await(entry.done), { discard: true }).pipe(
        Effect.timeoutOption(Duration.millis(waitMs)),
      )
    const late: Fiber.Fiber<void>[] = []
    for (const [, entry] of entries) {
      if (entry.phase !== "organizing") continue
      entry.sealed = true
      if (entry.fiber) late.push(entry.fiber)
    }
    // Sealed work can no longer adopt; stop its model calls without delaying the request.
    if (late.length > 0) yield* Fiber.interruptAll(late).pipe(Effect.forkIn(scope))
    // An adoption that passed the seal check is committing; include it rather than racing it.
    yield* Effect.forEach(
      entries.filter(([, entry]) => entry.phase === "adopting"),
      ([, entry]) => Deferred.await(entry.done),
      { discard: true },
    )
    const adopted: A[] = []
    for (const [key, entry] of entries) {
      state.jobs.delete(key)
      if (entry.adopted !== undefined) adopted.push(entry.adopted)
    }
    if (state.jobs.size === 0 && sessions.get(sessionID) === state) sessions.delete(sessionID)
    const fields = {
      "session.id": sessionID,
      "reasoning_distillation.barrier_jobs": entries.length,
      "reasoning_distillation.barrier_adopted": adopted.length,
      "reasoning_distillation.barrier_sealed": late.length,
      "reasoning_distillation.barrier_wait_ms": performance.now() - started,
      "reasoning_distillation.settle_window_ms": waitMs,
    }
    // Sealed parts are resent unchanged for good; make that visible without debug logging.
    if (late.length > 0) yield* Effect.logInfo("reasoning rewrite sealed", fields)
    else yield* Effect.logDebug("reasoning rewrite barrier", fields)
    return adopted
  })

  /** Jobs not yet collected by a barrier; diagnostics and tests only. */
  const pending = (sessionID: string) => sessions.get(sessionID)?.jobs.size ?? 0

  return { submit, settle, pending }
}

export type RewriteScheduler<A> = ReturnType<typeof makeRewriteScheduler<A>>
