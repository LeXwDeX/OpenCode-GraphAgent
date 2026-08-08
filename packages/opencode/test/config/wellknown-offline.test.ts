import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"

import { Config } from "@/config/config"
import { Auth } from "../../src/auth"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { Env } from "../../src/env"
import { testEffect } from "../lib/effect"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const testFlock = EffectFlock.defaultLayer

const wellKnownAuth = (url: string) =>
  Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        [url]: new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
      }),
  })

const configLayer = (client: HttpClient.HttpClient) =>
  Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(Env.defaultLayer),
    Layer.provide(wellKnownAuth("https://example.com")),
    Layer.provide(AccountTest.empty),
    Layer.provideMerge(infra),
    Layer.provide(NpmTest.noop),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provideMerge(FSUtil.defaultLayer),
  )

const it = (client: HttpClient.HttpClient) => testEffect(configLayer(client))

const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const transportFailure = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], description: string) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description }),
    }),
  )

// Well-known endpoint unreachable (DNS/connection failure): the transport never answers.
const unreachable = HttpClient.make((request) => transportFailure(request, "connect ECONNREFUSED"))

// Well-known endpoint answers, but the remote_config URL is unreachable.
const remoteConfigUnreachable = (seen: { wellKnown?: string; remote?: string }) =>
  HttpClient.make((request) => {
    const parsedUrl = new URL(request.url)
    if (parsedUrl.pathname.includes("/.well-known/opencode")) {
      seen.wellKnown = request.url
      return Effect.succeed(
        json(request, {
          config: { model: "embedded/model" },
          remote_config: { url: "https://config.example.com/opencode.json" },
        }),
      )
    }
    if (parsedUrl.hostname === "config.example.com") {
      seen.remote = request.url
      return transportFailure(request, "connect timeout")
    }
    return Effect.succeed(json(request, {}, 404))
  })

// Both hops succeed: remote config must merge exactly as before.
const remoteOk = (seen: { wellKnown?: string; remote?: string }) =>
  HttpClient.make((request) => {
    const parsedUrl = new URL(request.url)
    if (parsedUrl.pathname.includes("/.well-known/opencode")) {
      seen.wellKnown = request.url
      return Effect.succeed(json(request, { remote_config: { url: "https://config.example.com/opencode.json" } }))
    }
    if (parsedUrl.hostname === "config.example.com") {
      seen.remote = request.url
      return Effect.succeed(
        json(request, {
          config: { mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } } },
        }),
      )
    }
    return Effect.succeed(json(request, {}, 404))
  })

// Gateway answers the remote_config URL with an HTML login page (auth proxy, not an offline failure).
const loginPage = (seen: { wellKnown?: string; remote?: string }) =>
  HttpClient.make((request) => {
    if (request.url.includes(".well-known/opencode")) {
      seen.wellKnown = request.url
      return Effect.succeed(json(request, { remote_config: { url: "https://config.example.com/opencode.json" } }))
    }
    if (request.url.includes("config.example.com")) {
      seen.remote = request.url
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("<!DOCTYPE html><html><head><title>Sign in</title></head><body>Login required</body></html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        ),
      )
    }
    return Effect.succeed(json(request, {}, 404))
  })

// Well-known endpoint answers 200-OK with JSON content-type, but the body stream
// errors mid-read (truncated transfer / connection reset). Exercises the body-read
// degrade path (config.ts:210-217) distinct from the transport-level fetch degrade.
const bodyReadFails = HttpClient.make((request) => {
  if (request.url.includes(".well-known/opencode")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body stream interrupted"))
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    )
  }
  return Effect.succeed(json(request, {}, 404))
})

const unreachableIt = it(unreachable)

unreachableIt.instance(
  "wellknown transport failure degrades: config loads, local config intact, warning logged",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(config.model).toBe("local/model")
      expect(config.mcp?.jira?.enabled).toBe(true)
      const logs = JSON.stringify(yield* TestConsole.logLines)
      expect(logs).toContain("failed to fetch remote config")
      expect(logs).toContain("https://example.com/.well-known/opencode")
    }),
  {
    config: {
      model: "local/model",
      mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } },
    },
  },
)

const remoteUnreachableSeen: { wellKnown?: string; remote?: string } = {}
const remoteUnreachableIt = it(remoteConfigUnreachable(remoteUnreachableSeen))

remoteUnreachableIt.instance(
  "remote_config transport failure degrades: embedded wellknown config still merges, warning logged",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(remoteUnreachableSeen.wellKnown).toBe("https://example.com/.well-known/opencode")
      expect(remoteUnreachableSeen.remote).toBe("https://config.example.com/opencode.json")
      expect(config.model).toBe("embedded/model")
      const logs = JSON.stringify(yield* TestConsole.logLines)
      expect(logs).toContain("failed to fetch remote config")
      expect(logs).toContain("https://config.example.com/opencode.json")
    }),
)

const remoteOkSeen: { wellKnown?: string; remote?: string } = {}
const remoteOkIt = it(remoteOk(remoteOkSeen))

remoteOkIt.instance(
  "success path unchanged: remote config merges, no degradation warning",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(remoteOkSeen.wellKnown).toBe("https://example.com/.well-known/opencode")
      expect(remoteOkSeen.remote).toBe("https://config.example.com/opencode.json")
      expect(config.mcp?.confluence?.enabled).toBe(true)
      expect(JSON.stringify(yield* TestConsole.logLines)).not.toContain("failed to fetch remote config")
    }),
)

const loginPageSeen: { wellKnown?: string; remote?: string } = {}
const loginPageIt = it(loginPage(loginPageSeen))

loginPageIt.instance(
  "HTML login page stays a hard auth failure even with degradation enabled",
  () =>
    Effect.gen(function* () {
      const exit = yield* Config.use.get().pipe(Effect.exit)
      expect(loginPageSeen.remote).toBe("https://config.example.com/opencode.json")
      expect(Exit.isFailure(exit)).toBe(true)
    }),
)

const bodyReadFailsIt = it(bodyReadFails)

bodyReadFailsIt.instance(
  "wellknown body-read failure degrades: config loads, local config intact, warning logged",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(config.model).toBe("local/model")
      expect(config.mcp?.jira?.enabled).toBe(true)
      const logs = JSON.stringify(yield* TestConsole.logLines)
      expect(logs).toContain("failed to read remote config")
      expect(logs).toContain("https://example.com/.well-known/opencode")
    }),
  {
    config: {
      model: "local/model",
      mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } },
    },
  },
)
