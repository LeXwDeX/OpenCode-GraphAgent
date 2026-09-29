import { type ReasoningReplacement } from "@opencode-ai/core/session/reasoning-distillation/adoption"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/layer-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Effect, Layer, Semaphore } from "effect"
import * as Stream from "effect/Stream"
import { generateText, streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import { type LLMEvent } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import {
  ContextFolding,
  type HistorySnapshot as ContextFoldingHistorySnapshot,
  type RequestPurpose,
} from "./context-folding"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { ConfigReasoningDistillation } from "@opencode-ai/core/config/reasoning-distillation"
import { Flag } from "@opencode-ai/core/flag/flag"
import { contextFoldingDiagnostic, type ContextFoldingProjectionPlan } from "@opencode-ai/core/session/context-folding"
import { organizeReasoning, ReasoningDistillationPolicy } from "@opencode-ai/core/session/reasoning-distillation"
import { Token } from "@opencode-ai/core/util/token"
import { type ReasoningHistorySnapshot as ReasoningDistillationHistorySnapshot } from "./reasoning-distillation"
import { InstanceState } from "@/effect/instance-state"

export function strictJSON(text: string): unknown {
  // Models sometimes wrap JSON in a markdown fence despite "output JSON only"
  // instructions; strip the fence before parsing (defensive, mechanical only).
  const trimmed = text.trim()
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n/, "").replace(/\r?\n[ \t]*```\s*$/, "")
    : trimmed
  return JSON.parse(unfenced)
}

/** Privacy-safe failure category for distillation fallback logs: error tag or
 * class name only — never the error message, which may echo wire content. */
function errorCategory(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    const tag = (cause as { _tag?: unknown })._tag
    if (typeof tag === "string") return tag
    const name = (cause as { name?: unknown }).name
    if (typeof name === "string") return name
  }
  return "unknown"
}

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  purpose?: RequestPurpose
  contextFolding?: ContextFoldingHistorySnapshot
  reasoningDistillation?: ReasoningDistillationHistorySnapshot
  adoptReasoning?: (replacements: readonly ReasoningReplacement[]) => Effect.Effect<boolean>
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export type DistillInput = Pick<
  StreamInput,
  "user" | "sessionID" | "model" | "reasoningDistillation" | "adoptReasoning"
> & {
  /** Monotonic timestamps for the preparation and scheduler queue stages. */
  timing?: { prepareStarted: number; queued: number }
}

export interface Interface {
  readonly distill: (input: DistillInput) => Effect.Effect<void, unknown>
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service
    const fastDistillationState = yield* InstanceState.make(() =>
      Effect.succeed(
        new Map<
          string,
          {
            lock: Semaphore.Semaphore
            turns: Set<string>
            calls: number
            reservedTokens: number
            actualTokens: number
            paidAdmissionPaused: boolean
          }
        >(),
      ),
    )

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })
      const compatibility = yield* plugin.contextFoldingCompatibility()
      const dynamicFolding = ConfigCompaction.resolveDynamic({
        disabledByEnvironment: Flag.OPENCODE_DISABLE_PRUNE,
        dynamic: cfg.compaction?.dynamic,
        prune: cfg.compaction?.prune,
        knownExternalDcp: compatibility.knownExternalDcp,
      })
      const folding = {
        enabled: dynamicFolding.enabled,
        purpose: input.purpose ?? ("unknown" as const),
        history: input.contextFolding,
        system:
          prepared.params.options.instructions === undefined
            ? ({ kind: "messages" } as const)
            : ({ kind: "instructions", value: prepared.params.options.instructions } as const),
      }
      const bridge = yield* EffectBridge.make()

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const native = yield* LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
          contextFolding: folding,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo(
            "context folding",
            contextFoldingDiagnostic({
              runtime: "opencode-native",
              requestPurpose: folding.purpose,
              resolution: dynamicFolding,
              duplicatePlan: folding.history?.duplicatePlan,
              projectionPlan: native.contextFoldingPlan,
            }),
          )
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        result: streamText({
          // System messages are deliberately assembled by LLMRequestPrep.
          allowSystemInMessages: true,
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    const sourceMessages = ContextFolding.copyModelMessages(args.params.prompt)
                    const transformed = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                    let outbound = transformed
                    let projectionPlan: ContextFoldingProjectionPlan | undefined
                    const snapshot =
                      folding.enabled && folding.history && folding.purpose === "conversation" && sourceMessages
                        ? ContextFolding.bindModelMessages(folding.history, sourceMessages)
                        : undefined
                    if (snapshot) {
                      const projected = ContextFolding.projectAISDK({
                        model: input.model,
                        purpose: folding.purpose,
                        snapshot,
                        messages: transformed,
                        sourceMessages: sourceMessages ?? [],
                        messageTransformOptions: prepared.messageTransformOptions,
                        tools: prepared.tools,
                        toolChoice: input.toolChoice,
                        maxOutputTokens: prepared.params.maxOutputTokens,
                        params: prepared.params,
                        system: folding.system,
                      })
                      projectionPlan = projected.plan
                      if (projected.applied) outbound = projected.request.messages
                    }
                    await bridge.promise(
                      Effect.logInfo(
                        "context folding",
                        contextFoldingDiagnostic({
                          runtime: "opencode-ai-sdk",
                          requestPurpose: folding.purpose,
                          resolution: dynamicFolding,
                          duplicatePlan: folding.history?.duplicatePlan,
                          projectionPlan,
                        }),
                      ),
                    )
                    // @ts-expect-error
                    args.params.prompt = outbound
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            if (result.type === "native") return result.stream

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            )
          }),
        ),
      )

    const distill: Interface["distill"] = (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const workStarted = performance.now()
          const prepareMs = input.timing ? input.timing.queued - input.timing.prepareStarted : undefined
          const queueMs = input.timing ? workStarted - input.timing.queued : undefined
          const collectStarted = performance.now()
          const snapshot = input.reasoningDistillation
          if (!snapshot || !input.adoptReasoning) return
          const parts = snapshot.groups.flatMap((group) => group.parts)
          const counts = new Map<string, number>()
          for (const part of parts) {
            const key = JSON.stringify([part.messageID, part.partID])
            counts.set(key, (counts.get(key) ?? 0) + 1)
          }
          const slots = parts
            .filter(
              (part) =>
                part.canonicalEditable === true &&
                part.settled &&
                !part.distilled &&
                !part.signed &&
                !part.encrypted &&
                counts.get(JSON.stringify([part.messageID, part.partID])) === 1,
            )
            .map((part) => ({ messageID: part.messageID, partID: part.partID, text: part.text }))
          const inputCharacters = slots.reduce((total, slot) => total + slot.text.length, 0)
          const initialCollectMs = performance.now() - collectStarted
          if (slots.length === 0) return
          yield* InstanceState.useEffect(fastDistillationState, (states) => {
            let state = states.get(input.sessionID)
            if (!state) {
              state = {
                lock: Semaphore.makeUnsafe(1),
                turns: new Set(),
                calls: 0,
                reservedTokens: 0,
                actualTokens: 0,
                paidAdmissionPaused: false,
              }
              states.set(input.sessionID, state)
            }
            const current = state
            return current.lock.withPermit(
              Effect.gen(function* () {
                const started = performance.now()
                const cfg = yield* config.get()
                if (
                  !ConfigReasoningDistillation.resolveEnabled({
                    disabledByEnvironment: Flag.OPENCODE_DISABLE_REASONING_DISTILLATION,
                    enabled: cfg.reasoningDistillation?.enabled,
                  }).enabled
                )
                  return
                if (current.turns.has(input.user.id)) return
                if (
                  current.calls >= ReasoningDistillationPolicy.calls.maxCallsPerSession ||
                  current.paidAdmissionPaused
                ) {
                  yield* Effect.logInfo("reasoning organization skipped", {
                    "session.id": input.sessionID,
                    "reasoning_distillation.reason": "call-budget-exhausted",
                  })
                  return
                }
                current.turns.add(input.user.id)
                const modelSetupStarted = performance.now()
                const selected = yield* provider.getSmallModel(input.model.providerID)
                if (!selected) {
                  yield* Effect.logInfo("reasoning organization skipped", {
                    "session.id": input.sessionID,
                    "reasoning_distillation.reason": "small-model-unavailable",
                    "reasoning_distillation.model_calls": 0,
                    "reasoning_distillation.input_characters": inputCharacters,
                    "reasoning_distillation.collect_ms": initialCollectMs + performance.now() - modelSetupStarted,
                    "reasoning_distillation.total_ms": initialCollectMs + performance.now() - started,
                    "reasoning_distillation.prepare_ms": prepareMs ?? "unknown",
                    "reasoning_distillation.queue_ms": queueMs ?? "unknown",
                    "reasoning_distillation.end_to_end_ms": input.timing
                      ? performance.now() - input.timing.prepareStarted
                      : "unknown",
                  })
                  return
                }
                const language = yield* provider.getLanguage(selected)
                const requestedEffort = selected.variants?.none?.reasoningEffort === "none" ? "none" : "low"
                const collectMs = initialCollectMs + performance.now() - modelSetupStarted
                const bridge = yield* EffectBridge.make()
                const ctrl = yield* Effect.acquireRelease(
                  Effect.sync(() => new AbortController()),
                  (controller) => Effect.sync(() => controller.abort()),
                )
                let modelCalls = 0
                let outputCharacters = 0
                let reasoningCharacters = 0
                let reportedTotalTokens: number | undefined
                let failureCategory = "none"
                const organized = yield* Effect.tryPromise({
                  try: () =>
                    organizeReasoning({
                      slots,
                      callModel: async ({ prompt }) => {
                        const reservation =
                          Token.estimateReserve(prompt) + ReasoningDistillationPolicy.tokens.maxOutputTokens
                        if (
                          current.reservedTokens + reservation >
                          ReasoningDistillationPolicy.tokens.maxReservedTokensPerSession
                        ) {
                          failureCategory = "call-budget-exhausted"
                          return undefined
                        }
                        current.calls++
                        current.reservedTokens += reservation
                        modelCalls++
                        try {
                          const result = await bridge.promise(
                            Effect.tryPromise({
                              try: (signal) =>
                                generateText({
                                  model: language,
                                  prompt,
                                  temperature: 0,
                                  maxOutputTokens: ReasoningDistillationPolicy.tokens.maxOutputTokens,
                                  maxRetries: 0,
                                  providerOptions: { openaiCompatible: { reasoningEffort: requestedEffort } },
                                  abortSignal: AbortSignal.any([signal, ctrl.signal]),
                                }),
                              catch: (cause) => cause,
                            }).pipe(Effect.timeout(`${Flag.OPENCODE_REASONING_DISTILLATION_AUX_TIMEOUT_MS} millis`)),
                          )
                          outputCharacters = result.text.length
                          reasoningCharacters = result.reasoningText?.length ?? 0
                          reportedTotalTokens =
                            typeof result.totalUsage?.totalTokens === "number"
                              ? result.totalUsage.totalTokens
                              : undefined
                          current.actualTokens += reportedTotalTokens ?? 0
                          if (reportedTotalTokens === undefined || reportedTotalTokens > reservation)
                            current.paidAdmissionPaused = true
                          return {
                            text: result.text,
                            usageTokens: reportedTotalTokens,
                            finishReason: result.finishReason,
                          }
                        } catch (cause) {
                          failureCategory = ctrl.signal.aborted ? "abort" : errorCategory(cause)
                          current.paidAdmissionPaused = failureCategory !== "abort"
                          return undefined
                        }
                      },
                    }),
                  catch: (cause) => cause,
                })
                let adopted = false
                let adoptMs = 0
                if (organized.status === "organized") {
                  const latest = yield* config.get()
                  if (
                    !ctrl.signal.aborted &&
                    ConfigReasoningDistillation.resolveEnabled({
                      disabledByEnvironment: Flag.OPENCODE_DISABLE_REASONING_DISTILLATION,
                      enabled: latest.reasoningDistillation?.enabled,
                    }).enabled
                  ) {
                    const adoptStarted = performance.now()
                    adopted = yield* input.adoptReasoning!(organized.replacements)
                    adoptMs = performance.now() - adoptStarted
                  }
                }
                yield* Effect.logInfo("reasoning organization", {
                  "session.id": input.sessionID,
                  "reasoning_distillation.role": "organize",
                  "reasoning_distillation.provider": selected.providerID,
                  "reasoning_distillation.model": selected.id,
                  "reasoning_distillation.model_tier": "small",
                  "reasoning_distillation.requested_effort": requestedEffort,
                  "reasoning_distillation.slot_count": slots.length,
                  "reasoning_distillation.input_characters": inputCharacters,
                  "reasoning_distillation.model_calls": modelCalls,
                  "reasoning_distillation.collect_ms": collectMs,
                  "reasoning_distillation.model_ms": organized.timing.modelMs,
                  "reasoning_distillation.parse_ms": organized.timing.parseMs,
                  "reasoning_distillation.adopt_ms": adoptMs,
                  "reasoning_distillation.total_ms": initialCollectMs + performance.now() - started,
                  "reasoning_distillation.prepare_ms": prepareMs ?? "unknown",
                  "reasoning_distillation.queue_ms": queueMs ?? "unknown",
                  "reasoning_distillation.end_to_end_ms": input.timing
                    ? performance.now() - input.timing.prepareStarted
                    : "unknown",
                  "reasoning_distillation.output_characters": outputCharacters,
                  "reasoning_distillation.reasoning_characters": reasoningCharacters,
                  "reasoning_distillation.reported_total_tokens": reportedTotalTokens ?? "unknown",
                  "reasoning_distillation.status": organized.status,
                  "reasoning_distillation.reason": organized.reason ?? failureCategory,
                  "reasoning_distillation.adopted": adopted,
                  "reasoning_distillation.aux_reserved_tokens": current.reservedTokens,
                  "reasoning_distillation.aux_actual_tokens": current.actualTokens,
                  "reasoning_distillation.paid_admission_paused": current.paidAdmissionPaused,
                })
              }),
            )
          })
        }),
      )
    return Service.of({ stream, distill })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer), Layer.provide(EventV2Bridge.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(
      LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
    ),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make(layer, [
  Auth.node,
  Config.node,
  Provider.node,
  Plugin.node,
  Permission.node,
  EventV2Bridge.node,
  llmClient,
  RuntimeFlags.node,
])

export * as LLM from "./llm"
