import { Cause, Effect, Scope, Semaphore } from "effect"

/** One submission per completed user turn. First submission blocks; later ones belong to the service scope. */
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
    const first = !state && !input.previouslyDistilled
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
    if (first) yield* work
    else yield* work.pipe(Effect.forkIn(scope))
  })
}
