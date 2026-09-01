import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { parse } from "./assertions"
import { runtime, type Runtime } from "./runtime"
import type { ActiveScenario, BackendApp, CallResult, CaptureMode, SeededContext } from "./types"

type CallOptions = {
  auth?: {
    password?: string
    username?: string
  }
}

export function call(scenario: ActiveScenario, ctx: SeededContext<unknown>, options: CallOptions = {}) {
  // The signal parameter is load-bearing: Effect.promise is interruptible only
  // when the callback declares it (evaluate.length !== 0). Without it the
  // scenario timeout cannot break a stuck request and the runner hangs
  // silently. The signal is also threaded into the Request so the handler
  // side observes the abort.
  return Effect.promise(async (signal) =>
    capture(await app(await runtime(), options).request(toRequest(scenario, ctx, signal)), scenario.capture),
  )
}

export function callAuthProbe(scenario: ActiveScenario, credentials: "missing" | "valid" = "missing") {
  return Effect.promise(async (signal) => {
    const controller = new AbortController()
    // Forward fiber interruption (scenario timeout) into the probe abort so
    // neither the request nor the race below can outlive the scenario.
    const abortOuter = () => controller.abort("scenario interrupted")
    signal.addEventListener("abort", abortOuter, { once: true })
    try {
      return await Promise.race([
        Promise.resolve(
          app(await runtime(), { auth: { password: "secret" } }).request(
            toAuthProbeRequest(scenario, credentials, controller.signal),
          ),
        ).then((response) => capture(response, scenario.capture)),
        Bun.sleep(1_000).then(() => {
          controller.abort("auth probe timed out")
          return {
            status: 0,
            contentType: "",
            text: "auth probe timed out",
            body: undefined,
            timedOut: true,
          }
        }),
      ])
    } finally {
      signal.removeEventListener("abort", abortOuter)
    }
  })
}

export type CachedApp = BackendApp & { readonly dispose: () => Promise<void> }

export const appCache: Partial<Record<string, CachedApp>> = {}

export async function disposeApps(heartbeat?: (label: string) => void) {
  const apps = Object.values(appCache)
  for (const key of Object.keys(appCache)) delete appCache[key]
  heartbeat?.(`teardown: disposing ${apps.filter((app) => app !== undefined).length} app(s)`)
  await Promise.all(
    apps.flatMap((app, i) =>
      app === undefined
        ? []
        : [
            app.dispose().then(
              () => heartbeat?.(`teardown: app[${i}] disposed`),
              (err) => heartbeat?.(`teardown: app[${i}] dispose error: ${err}`),
            ),
          ],
    ),
  )
  heartbeat?.("teardown: all apps disposed")
}

function app(modules: Runtime, options: CallOptions) {
  const username = options.auth?.username
  const password = options.auth?.password
  const cacheKey = `${username ?? ""}:${password ?? ""}`
  if (appCache[cacheKey]) return appCache[cacheKey]

  const web = HttpRouter.toWebHandler(
    modules.HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: username }),
        ),
      ),
    ),
    { disableLogger: true, memoMap: modules.memoMap },
  )
  return (appCache[cacheKey] = {
    dispose: web.dispose,
    request(input: string | URL | Request, init?: RequestInit) {
      return web.handler(
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
        modules.HttpApiApp.context,
      )
    },
  })
}

function toRequest(scenario: ActiveScenario, ctx: SeededContext<unknown>, signal: AbortSignal) {
  const spec = scenario.request(ctx, ctx.state)
  return new Request(new URL(spec.path, "http://localhost"), {
    method: scenario.method,
    headers: spec.body === undefined ? spec.headers : { "content-type": "application/json", ...spec.headers },
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    signal,
  })
}

function toAuthProbeRequest(scenario: ActiveScenario, credentials: "missing" | "valid", signal: AbortSignal) {
  const spec = scenario.authProbe ?? {
    path: authProbePath(scenario.path),
    body: scenario.method === "GET" ? undefined : {},
  }
  const headers = {
    ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
    ...spec.headers,
    ...(credentials === "valid" ? { authorization: basic("opencode", "secret") } : {}),
  }
  return new Request(new URL(spec.path, "http://localhost"), {
    method: scenario.method,
    headers,
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    signal,
  })
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function authProbePath(path: string) {
  return path
    .replace(/\{([^}]+)\}/g, (_match, key: string) => `auth_${key}`)
    .replace(/:([^/]+)/g, (_match, key: string) => `auth_${key}`)
}

async function capture(response: Response, mode: CaptureMode): Promise<CallResult> {
  const text = mode === "stream" ? await captureStream(response) : await response.text()
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text,
    body: parse(text),
    timedOut: false,
  }
}

async function captureStream(response: Response) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const read = reader.read().then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  )
  const winner = await Promise.race([read, Bun.sleep(1_000).then(() => ({ timeout: true }))])
  if ("timeout" in winner) {
    await reader.cancel("timed out waiting for stream chunk").catch(() => undefined)
    throw new Error("timed out waiting for stream chunk")
  }
  if ("error" in winner) throw winner.error
  await reader.cancel().catch(() => undefined)
  if (winner.result.done) return ""
  return new TextDecoder().decode(winner.result.value)
}
