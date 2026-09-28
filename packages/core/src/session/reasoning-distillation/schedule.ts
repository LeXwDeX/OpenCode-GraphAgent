import { Cause, Effect, Scope, Semaphore } from "effect"

/** One submission per completed user turn. Work belongs to the service scope, including the first turn. */
export const makeTurnScheduler = (scope: Scope.Scope) => {
  const sessions = new Map<string, { turns: Set<string>; lock: Semaphore.Semaphore }>()
  return Effect.fn("ReasoningDistillation.schedule")(function* (input: {
    sessionID: string
    turnID: string
    previouslyDistilled?: boolean
    enabled: Effect.Effect<boolean>
    work: Effect.Effect<void, unknown>
  }) {
    if (!(yield* input.enabled)) return
    let state = sessions.get(input.sessionID)
    if (!state) {
      state = { turns: new Set(), lock: Semaphore.makeUnsafe(1) }
      sessions.set(input.sessionID, state)
    }
    if (state.turns.has(input.turnID)) return
    state.turns.add(input.turnID)
    const work = state.lock
      .withPermit(
        Effect.gen(function* () {
          if (yield* input.enabled) yield* input.work
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("reasoning distillation failed; retaining current history"),
        ),
      )
    yield* work.pipe(Effect.forkIn(scope))
  })
}
