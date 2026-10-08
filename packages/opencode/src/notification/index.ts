/**
 * notification-emitter — single internal choke point for "agent needs attention"
 * moments. Today's producers: permission asks (notificationType "permission") and
 * MCP elicitation asks (notificationType "elicitation"). The emitter fires the
 * `Notification` hook (resolved optionally so hook-less compositions stay valid)
 * and is the seam future OS/desktop notification delivery will plug into.
 *
 * Following the Todo/Question module pattern: self-contained `defaultLayer` with
 * no construction-time deps (SettingsHook resolved via serviceOption at call
 * time, per the AGENTS.md invariant for optional cross-deps).
 */
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Option } from "effect"
import { SettingsHook } from "@/hook/settings"

export interface NotifyInput {
  message: string
  title?: string
  /** Producer category — "permission" | "elicitation" | … */
  notificationType: string
  /** Session that needs attention; reported to the hook as `session_id`. */
  sessionID?: string
}

export interface Interface {
  /**
   * Record an "agent needs attention" moment. Fires the `Notification` hook
   * (optional, tolerant — hook failure never propagates). Future UI delivery
   * plugs in here without touching call sites.
   */
  readonly notify: (input: NotifyInput) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Notification") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // SettingsHook is resolved at CALL time (inside notify), not at layer
    // construction. This keeps the emitter self-contained: Layer.mergeAll
    // siblings don't cross-provide, so a construction-time serviceOption would
    // return None in merged compositions. Call-time resolution sees whatever
    // hooks context the notifying flow runs in (per the AGENTS.md invariant for
    // optional cross-deps).

    const notify = Effect.fn("Notification.notify")(function* (input: NotifyInput) {
      const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
      if (!settingsHook) return
      const nResult = yield* settingsHook
        .trigger(
          {
            event: "Notification",
            message: input.message,
            title: input.title,
            notificationType: input.notificationType,
          },
          { sessionID: input.sessionID ?? "", transcriptPath: "" },
        )
        .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] })))
      yield* SettingsHook.landSystemMessages(nResult, { sessionID: input.sessionID ?? "" })
    })

    return Service.of({ notify })
  }),
)

// No construction-time deps → self-contained. SettingsHook is ambient.
export const defaultLayer: Layer.Layer<Service> = layer

export const node = LayerNode.make(layer, [])

export * as Notification from "."
