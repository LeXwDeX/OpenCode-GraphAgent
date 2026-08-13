import { Cause, Effect, Option } from "effect"
import { SessionPrompt } from "@/session/prompt"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export function withIdleAdmission<Error, Value extends object>(
  service: Value & {
    readonly promptIfIdle: (
      input: SessionPrompt.PromptInput,
    ) => Effect.Effect<Option.Option<SessionV1.WithParts>, Error>
  },
) {
  return {
    ...service,
    prepareIfIdle: (input: SessionPrompt.PromptInput) =>
      Effect.succeed(
        Option.some({
          activate: Effect.void,
          result: service.promptIfIdle(input).pipe(
            Effect.flatMap(Option.match({ onNone: () => Effect.interrupt, onSome: Effect.succeed })),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.die(Cause.squash(cause)),
            ),
          ),
          abort: Effect.void,
        }),
      ),
  }
}
