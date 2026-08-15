import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// httpHandler runtime contract against a real local server: configured
// entry.headers MUST reach the wire (auth tokens were silently dropped before
// this fix), and non-2xx responses MUST surface as the synthetic exitBlock so
// the trigger aggregator reports a block.

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
  Layer.provideMerge(FetchHttpClient.layer),
)
const it = testEffect(testLayer)

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url.toString()),
    (server) => Effect.sync(() => server.stop(true)),
  )

describe("SettingsHook http handler", () => {
  it.instance("applies configured entry.headers to the outbound POST", () =>
    Effect.gen(function* () {
      const sessionHooks = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      let seen: Headers | undefined
      yield* withFetch(
        (req) => {
          seen = req.headers
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        },
        (url) =>
          Effect.gen(function* () {
            yield* sessionHooks.add(sessionID, {
              event: "UserPromptSubmit",
              hooks: [
                {
                  type: "http",
                  url,
                  headers: { authorization: "Bearer hook-secret", "x-hook-test": "present" },
                },
              ],
            })
            const r = yield* hook.trigger(
              { event: "UserPromptSubmit", prompt: "hi" },
              { sessionID, transcriptPath: "" },
            )
            expect(r.blocked).toBeUndefined()
            expect(seen).toBeDefined()
            expect(seen?.get("authorization")).toBe("Bearer hook-secret")
            expect(seen?.get("x-hook-test")).toBe("present")
          }),
      )
    }),
  )

  it.instance("non-2xx response surfaces as exitBlock", () =>
    Effect.gen(function* () {
      const sessionHooks = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* withFetch(
        () => new Response("nope", { status: 500 }),
        (url) =>
          Effect.gen(function* () {
            yield* sessionHooks.add(sessionID, {
              event: "UserPromptSubmit",
              hooks: [{ type: "http", url }],
            })
            const r = yield* hook.trigger(
              { event: "UserPromptSubmit", prompt: "hi" },
              { sessionID, transcriptPath: "" },
            )
            expect(r.blocked).toBeDefined()
            expect(r.blocked?.reason).toContain("500")
          }),
      )
    }),
  )
})
