import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/layer-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { asSchema, generateText, streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import { LLMRequest, type LLMEvent } from "@opencode-ai/llm"
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
import {
  contextFoldingDiagnostic,
  estimateContextFoldingBudget,
  type ContextFoldingProjectionPlan,
} from "@opencode-ai/core/session/context-folding"
import { ReasoningDistillationPolicy } from "@opencode-ai/core/session/reasoning-distillation"
import {
  ReasoningDistillation,
  type ReasoningHistorySnapshot as ReasoningDistillationHistorySnapshot,
} from "./reasoning-distillation"
import { InstanceState } from "@/effect/instance-state"
import { Hash } from "@opencode-ai/core/util/hash"

const REASONING_DISTILLATION_ADAPTER_VERSION = "opencode-reasoning-distillation-ai-sdk-v1"
const REASONING_DISTILLATION_NATIVE_ADAPTER_VERSION = "opencode-reasoning-distillation-native-v1"
const REASONING_DISTILLATION_PROTOCOL_OVERHEAD = 64

function hasMedia(messages: readonly ModelMessage[]): boolean {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === "file" || part.type === "image") return true
      if (part.type !== "tool-result" || typeof part.output !== "object" || part.output === null) continue
      if (
        "type" in part.output &&
        part.output.type === "content" &&
        "value" in part.output &&
        Array.isArray(part.output.value) &&
        part.output.value.some(
          (item) => typeof item === "object" && item !== null && "type" in item && item.type !== "text",
        )
      )
        return true
    }
  }
  return false
}

function wireTools(tools: Record<string, Tool>) {
  return Object.entries(tools)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, item]) => ({
      name,
      description: item.description ?? "",
      inputSchema: asSchema(item.inputSchema).jsonSchema,
      ...(item.strict === undefined ? {} : { strict: item.strict }),
    }))
}

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

function plainWireMessages(messages: readonly unknown[]): unknown[] | undefined {
  try {
    const result: unknown = JSON.parse(JSON.stringify(messages))
    return Array.isArray(result) ? result : undefined
  } catch {
    return undefined
  }
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
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
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
    const distillationState = yield* InstanceState.make(() =>
      Effect.succeed({
        current: ReasoningDistillation.emptyLifecycleState,
        busy: false,
      }),
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
      const distillationResolution = ConfigReasoningDistillation.resolveEnabled({
        disabledByEnvironment: Flag.OPENCODE_DISABLE_REASONING_DISTILLATION,
        enabled: cfg.reasoningDistillation?.enabled,
      })
      const interleavedField =
        typeof input.model.capabilities.interleaved === "object"
          ? input.model.capabilities.interleaved.field
          : undefined
      const organizer =
        distillationResolution.enabled && interleavedField
          ? ((yield* provider.getSmallModel(input.model.providerID)) ?? input.model)
          : undefined
      const organizerResolution = organizer
        ? ReasoningDistillation.resolveOrganizerTier(
            {
              small: {
                providerID: organizer.providerID,
                modelID: organizer.id,
                contextLimit: organizer.limit.context,
              },
              agent: {
                providerID: input.model.providerID,
                modelID: input.model.id,
                variant: input.user.model.variant,
                contextLimit: input.model.limit.context,
              },
              primary: {
                providerID: input.model.providerID,
                modelID: input.model.id,
                variant: input.user.model.variant,
                contextLimit: input.model.limit.context,
              },
            },
            ReasoningDistillationPolicy.tokens.maxInputTokens + ReasoningDistillationPolicy.tokens.maxOutputTokens,
          )
        : undefined

      const bridge = yield* EffectBridge.make()

      const callAuxiliary = organizerResolution
        ? async (prompt: string) =>
            bridge.promise(
              Effect.gen(function* () {
                const selected = organizerResolution.tier === "small" ? organizer : input.model
                if (!selected)
                  return yield* Effect.fail(new ReasoningDistillation.AuxiliaryCallError({ category: "transport" }))
                const organizerLanguage = yield* provider.getLanguage(selected)
                const settled = yield* Effect.tryPromise({
                  try: (signal) =>
                    generateText({
                      model: organizerLanguage,
                      prompt,
                      temperature: 0,
                      maxOutputTokens: ReasoningDistillationPolicy.tokens.maxOutputTokens,
                      maxRetries: 0,
                      // Auxiliary organizers must answer inside the output budget: on real
                      // reasoning relays the default thinking mode spends the whole cap on
                      // reasoning_content before any answer (2026-09-27 finding). Providers
                      // other than openai-compatible ignore this namespace.
                      providerOptions: { openaiCompatible: { reasoningEffort: "low" } },
                      abortSignal: AbortSignal.any([signal, input.abort]),
                    }),
                  catch: (cause) => cause,
                }).pipe(
                  Effect.timeout(`${Flag.OPENCODE_REASONING_DISTILLATION_AUX_TIMEOUT_MS} millis`),
                  Effect.map((result) => ({ ok: true as const, result })),
                  Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
                )
                if (!settled.ok) {
                  const category: ReasoningDistillation.AuxiliaryFailureCategory = input.abort.aborted
                    ? "abort"
                    : errorCategory(settled.cause) === "TimeoutError"
                      ? "timeout"
                      : "transport"
                  yield* Effect.logWarning("reasoning distillation auxiliary call failed", {
                    "reasoning_distillation.aux_failure_category": category,
                  })
                  return yield* Effect.fail(new ReasoningDistillation.AuxiliaryCallError({ category }))
                }
                const result = settled.result
                const usageTokens =
                  typeof result.totalUsage?.totalTokens === "number" ? result.totalUsage.totalTokens : undefined
                if (usageTokens === undefined)
                  yield* Effect.logWarning("reasoning distillation auxiliary usage unavailable", {
                    "reasoning_distillation.aux_text_length": result.text.length,
                    "reasoning_distillation.aux_has_total_usage": result.totalUsage !== undefined,
                  })
                if (result.text.length > ReasoningDistillationPolicy.tokens.maxOutputTokens * 4) {
                  yield* Effect.logWarning("reasoning distillation auxiliary output exceeded limit", {
                    "reasoning_distillation.aux_text_length": result.text.length,
                  })
                  return yield* Effect.fail(
                    new ReasoningDistillation.AuxiliaryCallError({
                      category: "oversize",
                      ...(usageTokens === undefined ? {} : { usageTokens }),
                    }),
                  )
                }
                try {
                  return {
                    output: strictJSON(result.text),
                    ...(usageTokens === undefined ? {} : { usageTokens }),
                  }
                } catch {
                  yield* Effect.logWarning("reasoning distillation auxiliary output was not valid JSON", {
                    "reasoning_distillation.aux_text_length": result.text.length,
                  })
                  return yield* Effect.fail(
                    new ReasoningDistillation.AuxiliaryCallError({
                      category: "parse",
                      ...(usageTokens === undefined ? {} : { usageTokens }),
                    }),
                  )
                }
              }),
            )
        : undefined

      const distillRequest = <Request>(args: {
        runtime: string
        adapterVersion: string
        request: Request
        messages: readonly unknown[]
        sourceMessages: readonly ModelMessage[]
        slots: readonly ReasoningDistillation.ReasoningSlotObservation[]
      }) => {
        const selected = args.slots.filter((slot) => slot.structureRewritable && slot.settled)
        if (selected.length === 0 || !organizerResolution) return Effect.succeed(args.request)
        const capability = {
          runtime: args.runtime,
          protocol: input.model.api.npm === "@ai-sdk/openai-compatible" ? "openai-compatible" : input.model.api.npm,
          providerModelVariant: `${input.model.providerID}/${input.model.id}/${input.user.model.variant ?? "default"}`,
          endpointIdentity: Hash.sha256(
            typeof item.options.baseURL === "string" ? item.options.baseURL : input.model.api.url,
          ),
          adapterVersion: args.adapterVersion,
          optionsFingerprint: Hash.sha256(JSON.stringify(prepared.params.options ?? {})),
        }
        const budget = {
          contextLimit: input.model.limit.context,
          inputLimit:
            input.model.limit.input === undefined
              ? ({ kind: "absent" } as const)
              : ({ kind: "value", value: input.model.limit.input } as const),
          outputReserve: prepared.params.maxOutputTokens,
          system: folding.system,
          messages: args.messages,
          tools: wireTools(prepared.tools),
          protocolOverheadTokens: REASONING_DISTILLATION_PROTOCOL_OVERHEAD,
          media: hasMedia(args.sourceMessages) ? ("unknown" as const) : ("none" as const),
        }
        const estimatedBudget = estimateContextFoldingBudget(budget)
        return InstanceState.useEffect(distillationState, (state) => {
          // Non-blocking admission: while one auxiliary call is in flight, another request's cycle is skipped
          // instead of queueing behind it. The old semaphore stalled unrelated sessions for up to the whole aux
          // timeout; skipping only forgoes an opportunistic distillation cycle, and the next ordinary request
          // runs its own.
          if (state.busy)
            return Effect.logInfo("reasoning distillation skipped: an auxiliary call is already in flight", {
              "reasoning_distillation.runtime": args.runtime,
              "reasoning_distillation.enabled": true,
              "reasoning_distillation.source": distillationResolution.source,
              "reasoning_distillation.attempted": "none",
              "reasoning_distillation.applied": false,
              "reasoning_distillation.skip_reason": "aux-busy",
            }).pipe(Effect.as(args.request))
          state.busy = true
          return Effect.tryPromise({
            try: async () => {
              try {
                return await ReasoningDistillation.runDistillationCycle(state.current, {
                  request: args.request,
                  identity: {
                    adapter: args.adapterVersion,
                    providerID: input.model.providerID,
                    modelID: input.model.id,
                    ...(input.user.model.variant === undefined ? {} : { variant: input.user.model.variant }),
                  },
                  sessionID: input.sessionID,
                  purpose: folding.purpose,
                  trigger: ReasoningDistillation.isDistillationTurn(input.reasoningDistillation?.reasoningTurn ?? 0)
                    ? "scheduled"
                    : "idle",
                  synchronous: true,
                  evidenceByMessage: input.reasoningDistillation?.scopes,
                  budget,
                  slots: selected,
                  calls: input.reasoningDistillation?.calls ?? [],
                  inventoryComplete: input.reasoningDistillation?.inventoryComplete ?? false,
                  evidenceReferences: input.reasoningDistillation?.references,
                  inventoryFingerprint: input.reasoningDistillation?.inventoryFingerprint ?? "missing-inventory",
                  capability,
                  records: cfg.reasoningDistillation?.compatibility ?? [],
                  organizerFingerprint: organizerResolution.organizerFingerprint,
                  originalTokens: Math.ceil(selected.reduce((total, slot) => total + slot.text.length, 0) / 4),
                  callPropose: callAuxiliary,
                  callJudge: callAuxiliary,
                  commitState: (next) => void (state.current = next),
                })
              } finally {
                state.busy = false
              }
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.tap((result) => Effect.sync(() => void (state.current = result.state))),
            Effect.tap((cycle) => {
              const usage = cycle.state.usageBySession[input.sessionID]
              return Effect.logInfo("reasoning distillation", {
                "session.id": input.sessionID,
                "reasoning_distillation.turn": input.reasoningDistillation?.reasoningTurn ?? 0,
                "reasoning_distillation.capability": capability,
                "reasoning_distillation.runtime": args.runtime,
                "reasoning_distillation.enabled": true,
                "reasoning_distillation.source": distillationResolution.source,
                "reasoning_distillation.attempted": cycle.attempted,
                "reasoning_distillation.applied": cycle.projection.applied,
                "reasoning_distillation.skip_reason": cycle.projection.skipReason ?? "none",
                "reasoning_distillation.slot_count": args.slots.length,
                "reasoning_distillation.estimated_input_tokens": estimatedBudget.estimatedInputTokens ?? "unknown",
                "reasoning_distillation.target_tokens": estimatedBudget.targetTokens ?? "unknown",
                "reasoning_distillation.budget_skip_reason": estimatedBudget.skipReason ?? "none",
                "reasoning_distillation.aux_reserved_tokens": usage?.reservedTokens ?? 0,
                "reasoning_distillation.aux_actual_tokens": usage?.actualTokens ?? 0,
                "reasoning_distillation.aux_unknown_usage_calls": usage?.unknownUsageCalls ?? 0,
                "reasoning_distillation.aux_latency_ms": usage?.latencyMs ?? 0,
                "reasoning_distillation.paid_admission_paused": usage?.paidAdmissionPaused ?? false,
              })
            }),
            Effect.map((cycle) => cycle.projection.request),
          )
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("reasoning distillation failed", {
              "reasoning_distillation.runtime": args.runtime,
              "reasoning_distillation.error": errorCategory(cause),
            }).pipe(Effect.as(args.request)),
          ),
        )
      }

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
          reasoningDistillation:
            distillationResolution.enabled && interleavedField && organizerResolution && input.reasoningDistillation
              ? ({ request, sourceMessages, transformedMessages }) => {
                  const messages = plainWireMessages(request.messages)
                  if (!messages) return Effect.succeed(request)
                  const lineage = ReasoningDistillation.bindNativeInterleavedReasoningLineage(
                    sourceMessages,
                    transformedMessages,
                    interleavedField,
                    input.reasoningDistillation!,
                  )
                  const slots = ReasoningDistillation.extractNativeInterleavedReasoningSlots(
                    messages,
                    interleavedField,
                    lineage,
                  )
                  return distillRequest({
                    runtime: "opencode-native",
                    adapterVersion: REASONING_DISTILLATION_NATIVE_ADAPTER_VERSION,
                    request: { messages },
                    messages,
                    sourceMessages,
                    slots,
                  }).pipe(
                    Effect.map((next) =>
                      next.messages === messages
                        ? request
                        : LLMRequest.update(request, { messages: next.messages as typeof request.messages }),
                    ),
                  )
                }
              : undefined,
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
                    if (
                      distillationResolution.enabled &&
                      interleavedField &&
                      organizerResolution &&
                      sourceMessages &&
                      input.reasoningDistillation
                    ) {
                      const messages = plainWireMessages(outbound)
                      if (messages) {
                        const lineage = ReasoningDistillation.bindInterleavedReasoningLineage(
                          sourceMessages,
                          transformed,
                          interleavedField,
                          input.reasoningDistillation,
                        )
                        const observed = ReasoningDistillation.extractInterleavedReasoningSlots(
                          messages,
                          interleavedField,
                          ["messages"],
                          lineage,
                        )
                        const projected = await bridge.promise(
                          distillRequest({
                            runtime: "opencode-ai-sdk",
                            adapterVersion: REASONING_DISTILLATION_ADAPTER_VERSION,
                            request: { messages },
                            messages,
                            sourceMessages,
                            slots: observed,
                          }),
                        )
                        outbound = projected.messages as ModelMessage[]
                      }
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

    return Service.of({ stream })
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
