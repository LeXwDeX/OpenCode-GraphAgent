import {
  fingerprintContextFoldingRequest,
  planContextFolding,
  projectContextFoldingRequest,
  type ContextFoldingProjectionResult,
  type FoldPlan,
  type FoldCandidate,
  type FoldRef,
  type FoldStep,
  type PreparedRequestBudgetInput,
  type ProjectionSkipReason,
  type WireCallMapping,
  type WireProjectionSnapshot,
  type WireResultMapping,
} from "@opencode-ai/core/session/context-folding"
import { Token } from "@opencode-ai/core/util/token"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { isRecord } from "@/util/record"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { Effect } from "effect"
import type { Interface as ToolSourceLedgerInterface } from "./tool-source-ledger"

const PROTOCOL_OVERHEAD_TOKENS = 64
const MAX_COPY_DEPTH = 64
const MAX_COPY_NODES = 131_072

export type RequestPurpose = "conversation" | "compaction" | "auxiliary" | "unknown"

export type HistoryReference = Readonly<{
  ref: FoldRef
  toolName: string
  complete: boolean
}>

export type Snapshot = Readonly<{
  duplicatePlan: FoldPlan
  references: readonly HistoryReference[]
}>

type ProjectionInput = Readonly<{
  model: Provider.Model
  purpose: RequestPurpose
  snapshot: Snapshot
  tools: Record<string, Tool>
  toolChoice?: "auto" | "required" | "none"
  maxOutputTokens: number | undefined
  params: unknown
  system: PreparedRequestBudgetInput["system"]
}>

type PlainCopy<T = unknown> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>

function independentWireCopy<T>(value: T, allowedClasses?: ReadonlySet<string>): PlainCopy<T>
function independentWireCopy(value: unknown, allowedClasses: ReadonlySet<string> = new Set()): PlainCopy {
  let nodes = 0
  const copy = (current: unknown, ancestors: Set<object>, depth: number): PlainCopy => {
    nodes++
    if (nodes > MAX_COPY_NODES || depth > MAX_COPY_DEPTH) return { ok: false }
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return { ok: true, value: current }
    }
    if (typeof current === "number") return Number.isFinite(current) ? { ok: true, value: current } : { ok: false }
    if (typeof current !== "object" || ancestors.has(current)) return { ok: false }

    const nextAncestors = new Set(ancestors)
    nextAncestors.add(current)
    try {
      const prototype = Object.getPrototypeOf(current)
      if (Array.isArray(current)) {
        if (prototype !== Array.prototype) return { ok: false }
        const keys = Reflect.ownKeys(current)
        if (keys.length !== current.length + 1 || keys.some((key) => typeof key === "symbol")) return { ok: false }
        const result: unknown[] = []
        for (let index = 0; index < current.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (!descriptor || !("value" in descriptor)) return { ok: false }
          const item = copy(descriptor.value, nextAncestors, depth + 1)
          if (!item.ok) return item
          result.push(item.value)
        }
        return { ok: true, value: result }
      }
      if (
        prototype !== Object.prototype &&
        prototype !== null &&
        !allowedClasses.has(String(prototype?.constructor?.name))
      )
        return { ok: false }
      const result: Record<string, unknown> = prototype === null ? Object.create(null) : {}
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string") return { ok: false }
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (!descriptor || !("value" in descriptor)) return { ok: false }
        if (!descriptor.enumerable || descriptor.value === undefined) continue
        const item = copy(descriptor.value, nextAncestors, depth + 1)
        if (!item.ok) return item
        Object.defineProperty(result, key, {
          value: item.value,
          enumerable: descriptor.enumerable,
          writable: true,
          configurable: true,
        })
      }
      return { ok: true, value: result }
    } catch {
      return { ok: false }
    }
  }
  return copy(value, new Set(), 0)
}

const missingSource = (sessionID: string, messageID: string, callID: string, toolName: string) => ({
  sessionID,
  assistantMessageID: messageID,
  callID,
  toolName,
  sourceKind: "unknown" as const,
  registrationID: "missing",
  registrationGeneration: "missing",
})

const estimateStep = (parts: readonly SessionV1.Part[]) => {
  try {
    return Token.estimate(JSON.stringify(parts))
  } catch {
    return -1
  }
}

export const history = Effect.fn("ContextFolding.history")(function* (input: {
  messages: readonly SessionV1.WithParts[]
  ledger: ToolSourceLedgerInterface
}) {
  const steps: FoldStep[] = []
  const references: HistoryReference[] = []

  for (const message of input.messages) {
    if (message.info.role !== "assistant") continue
    let stepParts: SessionV1.Part[] = []
    let stepID = `${message.info.id}:0`
    const flush = () =>
      Effect.gen(function* () {
        if (stepParts.length === 0) return
        const parts = stepParts
        const id = stepID
        stepParts = []
        const candidates: FoldCandidate[] = []
        for (const part of parts) {
          if (part.type !== "tool") continue
          const identity =
            (yield* input.ledger.lookup({
              sessionID: part.sessionID,
              assistantMessageID: part.messageID,
              callID: part.callID,
              toolName: part.tool,
            })) ?? missingSource(part.sessionID, part.messageID, part.callID, part.tool)
          const completedState = part.state.status === "completed" ? part.state : undefined
          const attachments: "none" | "present" =
            completedState && (completedState.attachments?.length ?? 0) > 0 ? "present" : "none"
          const complete =
            !!completedState &&
            completedState.time.compacted === undefined &&
            completedState.metadata.truncated !== true &&
            typeof completedState.metadata.outputPath !== "string"
          const ref = { messageID: part.messageID, partID: part.id, callID: part.callID }
          references.push({ ref, toolName: part.tool, complete })
          candidates.push({
            ref,
            toolName: part.tool,
            source: identity,
            status: part.state.status,
            input: part.state.input,
            result: completedState
              ? {
                  kind: "text" as const,
                  text: completedState.output,
                  complete,
                  comparisonMetadata: { title: completedState.title, metadata: completedState.metadata },
                }
              : { kind: "unknown" as const },
            safety: {
              attachments,
              instructions: "none" as const,
              providerExecuted: part.metadata?.providerExecuted === true,
            },
            ...(part.tool === "read" && typeof part.state.input.filePath === "string"
              ? { targetPath: part.state.input.filePath }
              : {}),
          })
        }
        steps.push({ id, estimatedTokens: estimateStep(parts), candidates })
      })

    for (const part of message.parts) {
      if (part.type === "step-start" && stepParts.length > 0) yield* flush()
      if (part.type === "step-start") stepID = part.id
      stepParts.push(part)
    }
    yield* flush()
  }

  return { duplicatePlan: planContextFolding(steps), references } satisfies Snapshot
})

function selectedReferences(snapshot: Snapshot) {
  const selected = new Set<string>()
  for (const replacement of snapshot.duplicatePlan.replacements) {
    selected.add(JSON.stringify(replacement.source))
    selected.add(JSON.stringify(replacement.witness))
  }
  return snapshot.references.filter((reference) => selected.has(JSON.stringify(reference.ref)))
}

function toolWire(tools: Record<string, Tool>) {
  return Object.entries(tools)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, item]) => ({
      name,
      description: item.description ?? "",
      inputSchema: asSchema(item.inputSchema).jsonSchema,
      ...(item.strict === undefined ? {} : { strict: item.strict }),
    }))
}

function hasMedia(messages: unknown) {
  if (!Array.isArray(messages)) return true
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!isRecord(part)) continue
      if (["file", "image", "media"].includes(String(part.type))) return true
      if (!isRecord(part.output) || part.output.type !== "content" || !Array.isArray(part.output.value)) continue
      if (part.output.value.some((item) => isRecord(item) && item.type !== "text")) return true
    }
  }
  return false
}

function budget(
  input: ProjectionInput,
  messages: unknown,
  tools: unknown,
  mediaMessages: unknown = messages,
): PreparedRequestBudgetInput {
  return {
    contextLimit: input.model.limit.context,
    inputLimit:
      input.model.limit.input === undefined ? { kind: "absent" } : { kind: "value", value: input.model.limit.input },
    outputReserve: input.maxOutputTokens,
    system: input.system,
    messages,
    tools,
    protocolOverheadTokens: PROTOCOL_OVERHEAD_TOKENS,
    media: hasMedia(mediaMessages) ? "unknown" : "none",
  }
}

function identity(input: ProjectionInput, runtime: "ai-sdk" | "native") {
  return {
    adapter: "opencode-context-folding-v1",
    runtime,
    purpose: input.purpose,
    providerID: input.model.providerID,
    modelID: input.model.id,
    apiID: input.model.api.id,
    npm: input.model.api.npm,
    ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
    params: input.params,
  }
}

type Located = Readonly<{
  path: readonly (string | number)[]
  bodyPath?: readonly (string | number)[]
  id: string
  name: string
  kind: "call" | "result"
}>

function locateAISDK(request: unknown): Located[] {
  if (!isRecord(request) || !Array.isArray(request.messages)) return []
  const located: Located[] = []
  request.messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return
    message.content.forEach((part, partIndex) => {
      if (!isRecord(part) || typeof part.toolCallId !== "string" || typeof part.toolName !== "string") return
      const base = ["messages", messageIndex, "content", partIndex] as const
      if (part.type === "tool-call") {
        located.push({ path: [...base, "toolCallId"], id: part.toolCallId, name: part.toolName, kind: "call" })
      }
      if (
        part.type === "tool-result" &&
        isRecord(part.output) &&
        (part.output.type === "text" || part.output.type === "error-text") &&
        typeof part.output.value === "string"
      ) {
        located.push({
          path: [...base, "toolCallId"],
          bodyPath: [...base, "output", "value"],
          id: part.toolCallId,
          name: part.toolName,
          kind: "result",
        })
      }
    })
  })
  return located
}

function locateNative(request: unknown): Located[] {
  if (!isRecord(request) || !Array.isArray(request.messages)) return []
  const located: Located[] = []
  request.messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return
    message.content.forEach((part, partIndex) => {
      if (!isRecord(part) || typeof part.id !== "string" || typeof part.name !== "string") return
      const base = ["messages", messageIndex, "content", partIndex] as const
      if (part.type === "tool-call") {
        located.push({ path: [...base, "id"], id: part.id, name: part.name, kind: "call" })
      }
      if (part.type !== "tool-result") return
      if (typeof part.result === "string") {
        located.push({
          path: [...base, "id"],
          bodyPath: [...base, "result"],
          id: part.id,
          name: part.name,
          kind: "result",
        })
      } else if (isRecord(part.result) && typeof part.result.value === "string") {
        located.push({
          path: [...base, "id"],
          bodyPath: [...base, "result", "value"],
          id: part.id,
          name: part.name,
          kind: "result",
        })
      }
    })
  })
  return located
}

function mapping(
  requestFingerprint: string,
  input: ProjectionInput,
  located: readonly Located[],
): WireProjectionSnapshot {
  const calls: WireCallMapping[] = []
  const results: WireResultMapping[] = []
  let callOrdinal = 0
  let resultOrdinal = 0
  for (const reference of selectedReferences(input.snapshot)) {
    const expectedID = ProviderTransform.toolCallID(reference.ref.callID, input.model)
    const call = located.filter(
      (item) => item.kind === "call" && item.id === expectedID && item.name === reference.toolName,
    )
    const result = located.filter(
      (item) => item.kind === "result" && item.id === expectedID && item.name === reference.toolName,
    )
    if (call.length !== 1 || result.length !== 1 || !result[0].bodyPath) continue
    calls.push({
      ref: reference.ref,
      visibleCallID: call[0].id,
      visibleCallIDPath: call[0].path,
      ordinal: callOrdinal++,
    })
    results.push({
      ref: reference.ref,
      visibleCallID: result[0].id,
      visibleCallIDPath: result[0].path,
      bodyPath: result[0].bodyPath,
      ordinal: resultOrdinal++,
      complete: reference.complete,
    })
  }
  return { requestFingerprint, calls, results }
}

function project<Request>(
  request: Request,
  input: ProjectionInput,
  runtime: "ai-sdk" | "native",
  preparedBudget: PreparedRequestBudgetInput,
  locate: (request: Request) => Located[],
  allowedClasses: ReadonlySet<string> = new Set(),
): ContextFoldingProjectionResult<Request> {
  const unchanged = (skipReason: ProjectionSkipReason) =>
    ({
      request,
      applied: false,
      plan: {
        replacements: [],
        estimatedBefore: undefined,
        estimatedAfter: undefined,
        targetTokens: undefined,
        overBudget: undefined,
        skipReason,
      },
    }) satisfies ContextFoldingProjectionResult<Request>
  if (input.purpose !== "conversation") return unchanged("no-eligible-duplicates")
  const copy = independentWireCopy(request, allowedClasses)
  if (!copy.ok) return unchanged("invalid-structure")
  const copiedBudget = independentWireCopy(preparedBudget, allowedClasses)
  if (!copiedBudget.ok) return unchanged("unknown-content")
  const tree = copy.value
  const finalBudget = copiedBudget.value
  const copiedIdentity = independentWireCopy(identity(input, runtime), allowedClasses)
  if (!copiedIdentity.ok) return unchanged("unknown-content")
  const requestIdentity = copiedIdentity.value
  const fingerprint = fingerprintContextFoldingRequest({
    request: tree,
    identity: requestIdentity,
    budget: finalBudget,
  })
  if (!fingerprint.ok) return unchanged(fingerprint.reason)
  return projectContextFoldingRequest({
    request: tree,
    identity: requestIdentity,
    expectedRequestFingerprint: fingerprint.value,
    duplicatePlan: input.snapshot.duplicatePlan,
    budget: finalBudget,
    mapping: mapping(fingerprint.value, input, locate(tree)),
  })
}

export function projectAISDK(input: ProjectionInput & { messages: ModelMessage[] }) {
  const request = { messages: input.messages }
  return project(request, input, "ai-sdk", budget(input, input.messages, toolWire(input.tools)), locateAISDK)
}

export function projectNative(
  input: ProjectionInput & {
    request: { readonly system: unknown; readonly messages: unknown; readonly tools: unknown }
  },
) {
  const request = { messages: input.request.messages }
  const transmitted = { system: input.request.system, messages: input.request.messages }
  return project(
    request,
    input,
    "native",
    budget(input, transmitted, input.request.tools, input.request.messages),
    locateNative,
    new Set(["Message", "SystemPart", "ToolDefinition"]),
  )
}

export * as ContextFolding from "./context-folding"
