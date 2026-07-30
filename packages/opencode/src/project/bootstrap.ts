import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { ShareNext } from "@/share/share-next"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { DagLoop } from "@/dag/runtime/loop"
import { DagSummaryPublisher } from "@/dag/runtime/summary-publisher"
import { SettingsHook } from "@/hook/settings"
import { Service } from "./bootstrap-service"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const dagLoop = yield* DagLoop.Service
    const dagPublisher = yield* DagSummaryPublisher.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      const initTargets: { init: () => Effect.Effect<void, unknown> }[] = [
        lsp,
        shareNext,
        format,
        vcs,
        snapshot,
        project,
      ]
      yield* Effect.forEach(
        initTargets,
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
      yield* dagLoop.init().pipe(Effect.catchCause((cause) => Effect.logWarning("dag loop init failed", { cause })))
      // DagSummaryPublisher: same lifecycle pattern. Stateless derived-view
      // publisher that pushes per-session workflow summaries to the TUI.
      yield* dagPublisher
        .init()
        .pipe(Effect.catchCause((cause) => Effect.logWarning("dag summary publisher init failed", { cause })))
      // SettingsHook: Setup fires once per instance bootstrap. Resolved lazily
      // so bootstrap layers stay self-contained.
      const settingsHook = yield* Effect.serviceOption(SettingsHook.Service)
      if (settingsHook._tag === "Some") {
        yield* settingsHook.value
          .trigger({ event: "Setup", trigger: "startup" }, { sessionID: "", transcriptPath: "" })
          .pipe(Effect.ignore)
      }
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([
    Config.defaultLayer,
    DagLoop.defaultLayer,
    DagSummaryPublisher.defaultLayer,
    Format.defaultLayer,
    LSP.defaultLayer,
    Plugin.defaultLayer,
    Project.defaultLayer,
    ShareNext.defaultLayer,
    Snapshot.defaultLayer,
    Vcs.defaultLayer,
  ]),
)

export const node = LayerNode.make(layer, [
  Config.node,
  DagLoop.node,
  DagSummaryPublisher.node,
  Format.node,
  LSP.node,
  Plugin.node,
  Project.node,
  ShareNext.node,
  Snapshot.node,
  Vcs.node,
])

export * as InstanceBootstrap from "./bootstrap"
