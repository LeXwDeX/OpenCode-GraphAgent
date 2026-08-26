/**
 * MCP elicitation adapter (spec rev with form + url modes; this change
 * implements the flat-primitive form-mode subset).
 *
 * Lives in the MCP module because it owns the protocol edge. Resolves Question,
 * SettingsHook, and Notification via `Effect.serviceOption` so MCP layers stay
 * self-contained (AGENTS.md invariant). Session routing is best-effort via the
 * `SessionContext` ALS set around MCP tool calls; with no session or no
 * Question service the adapter declines immediately — it never hangs the server.
 *
 * Lifecycle:
 *   elicitation/create ─▶ build Question request from requestedSchema
 *                          ─▶ fire Elicitation hook (blocking hook deny → decline, no surface)
 *                          ─▶ route through Notification emitter (type "elicitation")
 *                          ─▶ Question.ask (blocks until reply/reject/timeout)
 *   user reply ─▶ validate ─▶ accept+content / decline
 *   reject / timeout / no-context ─▶ decline
 *   ─▶ fire ElicitationResult hook (result | cancelled)
 *   ─▶ respond to server
 */
import { Effect, Option, Schema } from "effect"
import type { Client } from "@modelcontextprotocol/client"
import { Question } from "@/question"
import { SettingsHook, type TriggerResult } from "@/hook/settings"
import { Notification } from "@/notification"
import { SessionContext } from "@/effect/session-context"
import { SessionID } from "@/session/schema"

/** Hard cap on how long an elicitation waits for a user answer. */
const ELICITATION_TIMEOUT_MS = 300_000

/**
 * Active session for routing server-initiated elicitation.
 *
 * MCP clients are shared per-server, so the `elicitation/create` handler has no
 * ambient session of its own. AsyncLocalStorage (`SessionContext`) does NOT
 * survive the MCP SDK's transport dispatch (the reverse-request runs in the
 * transport's callback context, not the callTool's async context), so the
 * handler reads this module-level slot instead. It is set synchronously by MCP
 * tool execution (`session/tools.ts`) around the server call and cleared on
 * completion. Sequential tool calls (the turn norm) overwrite cleanly;
 * concurrent cross-session MCP calls are best-effort (last writer wins) —
 * acceptable and strictly better than ALS-only routing, which never resolves.
 */
type ActiveElicitationSession = { id: string; token: number }
type ActiveElicitationSessionCleanup = () => void

let activeSessionToken = 0
const activeSession: ActiveElicitationSession[] = []
export const setActiveElicitationSession = (id: string | undefined): ActiveElicitationSessionCleanup => {
  if (id === undefined) {
    activeSession.splice(0)
    return () => {}
  }

  const entry = { id, token: activeSessionToken++ }
  activeSession.push(entry)
  return () => {
    const index = activeSession.findIndex((item) => item.token === entry.token)
    if (index >= 0) activeSession.splice(index, 1)
  }
}

export type ElicitAction = "accept" | "decline" | "cancel"
export interface ElicitResponse {
  action: ElicitAction
  content?: Record<string, string | number | boolean | string[]>
}

/**
 * A single flat-primitive property from the requested schema, after validation
 * that the schema is conforming. Non-conforming properties (nested objects,
 * arrays, url-mode) cause the whole elicitation to be rejected.
 */
interface FieldSpec {
  name: string
  description?: string
  kind: "enum" | "boolean" | "string" | "number" | "integer"
  enumValues?: string[]
}

/**
 * Classify a requested-schema property into a FieldSpec, or return a rejection
 * reason. MCP form-mode allows flat objects whose properties are primitive
 * string/number/integer/boolean, optionally with an enum.
 */
export function classifyProperty(name: string, prop: unknown): { field: FieldSpec } | { reject: string } {
  if (typeof prop !== "object" || prop === null || Array.isArray(prop))
    return { reject: `property "${name}" must be an object` }
  const p = prop as Record<string, unknown>
  const type = p.type
  // enum (string enum) → options
  if (Array.isArray(p.enum)) {
    const enumValues = p.enum.filter((v): v is string => typeof v === "string")
    if (enumValues.length !== p.enum.length) return { reject: `property "${name}" enum must be all strings` }
    return {
      field: {
        name,
        description: typeof p.description === "string" ? p.description : undefined,
        kind: "enum",
        enumValues,
      },
    }
  }
  if (type === "boolean") {
    return {
      field: { name, description: typeof p.description === "string" ? p.description : undefined, kind: "boolean" },
    }
  }
  if (type === "string") {
    return {
      field: { name, description: typeof p.description === "string" ? p.description : undefined, kind: "string" },
    }
  }
  if (type === "number") {
    return {
      field: { name, description: typeof p.description === "string" ? p.description : undefined, kind: "number" },
    }
  }
  if (type === "integer") {
    return {
      field: { name, description: typeof p.description === "string" ? p.description : undefined, kind: "integer" },
    }
  }
  return { reject: `property "${name}" type "${String(type)}" not supported (flat primitives only)` }
}

/**
 * Map a flat-primitive requestedSchema into Question `Info[]` (one per field),
 * or reject the whole schema. Exposed for unit testing.
 */
export function schemaToQuestions(
  message: string,
  requestedSchema: unknown,
): { questions: Question.Info[] } | { reject: string } {
  if (typeof requestedSchema !== "object" || requestedSchema === null)
    return { reject: "requestedSchema must be an object" }
  const schema = requestedSchema as Record<string, unknown>
  if (schema.type !== "object") return { reject: "requestedSchema must be type 'object'" }
  const properties = schema.properties
  if (typeof properties !== "object" || properties === null || Array.isArray(properties))
    return { reject: "requestedSchema.properties must be an object" }

  const fields: FieldSpec[] = []
  for (const [name, prop] of Object.entries(properties as Record<string, unknown>)) {
    const result = classifyProperty(name, prop)
    if ("reject" in result) return result
    fields.push(result.field)
  }

  const QuestionV1Info = Question.Info
  const questions = fields.map((field) => {
    if (field.kind === "enum") {
      return QuestionV1Info.make({
        question: field.description ?? `${field.name}: ${field.enumValues!.join(" | ")}`,
        header: field.name,
        options: field.enumValues!.map((value) => Question.Option.make({ label: value, description: value })),
        multiple: undefined,
        custom: false,
      })
    }
    if (field.kind === "boolean") {
      return QuestionV1Info.make({
        question: field.description ?? `${field.name}?`,
        header: field.name,
        options: [
          Question.Option.make({ label: "Yes", description: "true" }),
          Question.Option.make({ label: "No", description: "false" }),
        ],
        multiple: undefined,
        custom: false,
      })
    }
    // string / number → free-text input
    return QuestionV1Info.make({
      question: field.description ?? `${field.name} (${field.kind})`,
      header: field.name,
      options: [],
      multiple: undefined,
      custom: true,
    })
  })
  return { questions }
}

/**
 * Validate a set of answers (arrays of selected labels, one per field) against
 * the field specs, coercing to the MCP content shape. Returns the structured
 * content on success, or undefined if any answer is invalid (→ decline).
 * Exposed for unit testing.
 */
export function validateAndCoerce(
  fields: FieldSpec[],
  answers: ReadonlyArray<ReadonlyArray<string>>,
): Record<string, string | number | boolean> | undefined {
  const content: Record<string, string | number | boolean> = {}
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const answer = answers[i] ?? []
    if (field.kind === "enum") {
      // single-select; take first selected label, must be in enum
      const selected = answer[0]
      if (!selected || !field.enumValues!.includes(selected)) return undefined
      content[field.name] = selected
    } else if (field.kind === "boolean") {
      const selected = answer[0]
      if (selected === "Yes") content[field.name] = true
      else if (selected === "No") content[field.name] = false
      else return undefined
    } else if (field.kind === "string") {
      const selected = answer[0]
      if (typeof selected !== "string") return undefined
      content[field.name] = selected
    } else {
      // number / integer
      const selected = answer[0]
      if (typeof selected !== "string") return undefined
      const num = Number(selected)
      if (!Number.isFinite(num)) return undefined
      if (field.kind === "integer" && !Number.isInteger(num)) return undefined
      content[field.name] = num
    }
  }
  return content
}

/** Re-derive FieldSpec[] from a requestedSchema for use by validateAndCoerce. */
export function fieldSpecsFromSchema(requestedSchema: unknown): FieldSpec[] {
  const schema = requestedSchema as { properties?: Record<string, unknown> }
  const properties = schema.properties ?? {}
  const fields: FieldSpec[] = []
  for (const [name, prop] of Object.entries(properties)) {
    const result = classifyProperty(name, prop)
    if ("field" in result) fields.push(result.field)
  }
  return fields
}

/**
 * The Effect that handles one elicitation/create request. Pure of protocol I/O:
 * returns an ElicitResponse the caller (a Promise wrapper) sends to the server.
 *
 * `deps` carried by the ambient context (Question, SettingsHook, Notification
 * all resolved via serviceOption); absent services cause safe decline.
 */
export const handleElicitation = Effect.fn("MCP.elicitation.handle")(function* (input: {
  message: string
  requestedSchema: unknown
  mode?: string
  /**
   * The session that triggered the MCP tool call. Best-effort: read synchronously
   * from `SessionContext` at handler entry (visible only if the MCP SDK preserves
   * the callTool async context). Undefined → decline (never hang the server).
   */
  sessionID?: string
}) {
  // url-mode and other non-form modes are out of scope (Non-Goal) → decline.
  if (input.mode !== undefined && input.mode !== "form") {
    return { action: "decline" } satisfies ElicitResponse
  }

  const question = Option.getOrUndefined(yield* Effect.serviceOption(Question.Service))
  const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
  const notification = Option.getOrUndefined(yield* Effect.serviceOption(Notification.Service))
  const sessionID = input.sessionID

  // No interaction layer or no session context → decline immediately. These
  // branches used to decline silently (Question never surfaces, the caller just
  // sees a decline), which made routing failures unobservable; log the reason
  // and a routing snapshot so a decline here is diagnosable in production logs.
  if (!question || !sessionID) {
    yield* Effect.logWarning("elicitation declined without surfacing", {
      reason: !question ? "no Question service" : "no sessionID",
      sessionContext: SessionContext.sessionID,
      activeSessionFallback: activeSession.map((entry) => entry.id),
    })
    return { action: "decline" } satisfies ElicitResponse
  }

  const mapped = schemaToQuestions(input.message, input.requestedSchema)
  if ("reject" in mapped) {
    yield* Effect.logWarning("elicitation schema rejected", { reason: mapped.reject })
    return { action: "decline" } satisfies ElicitResponse
  }

  // Elicitation hook fires before surfacing. A blocking deny short-circuits to
  // decline without surfacing the Question.
  if (settingsHook) {
    const hookResult = yield* settingsHook
      .trigger({ event: "Elicitation", prompt: input.message, schema: input.requestedSchema } as never, {
        sessionID,
        transcriptPath: "",
      })
      .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
    yield* SettingsHook.landSystemMessages(hookResult as TriggerResult, { sessionID })
    if ((hookResult as TriggerResult).blocked) {
      yield* Effect.logWarning("elicitation declined: hook blocked")
      return { action: "decline" } satisfies ElicitResponse
    }
  }

  // Route the ask through the Notification emitter (non-blocking, tolerant).
  if (notification) {
    yield* notification
      .notify({ message: input.message || "MCP elicitation", notificationType: "elicitation" })
      .pipe(Effect.ignore)
  }

  // Surface and await the user's answer with a bounded timeout. Timeout or
  // rejection (user dismissed) both resolve to decline; only a validated reply
  // resolves to accept.
  const fields = fieldSpecsFromSchema(input.requestedSchema)
  const validated = yield* question.ask({ sessionID: SessionID.make(sessionID), questions: mapped.questions }).pipe(
    // timeoutOption returns None on timeout; timeoutOrElse would also work.
    Effect.timeoutOption(ELICITATION_TIMEOUT_MS),
    Effect.map((opt) => (Option.isNone(opt) ? undefined : validateAndCoerce(fields, opt.value))),
    Effect.catch(() => Effect.succeed<undefined>(undefined)), // user reject (RejectedError) → decline
  )

  // ElicitationResult hook fires on resolution (result on accept, cancelled otherwise).
  if (settingsHook) {
    const resultPayload =
      validated !== undefined
        ? ({ event: "ElicitationResult", result: validated } as never)
        : ({ event: "ElicitationResult", cancelled: true } as never)
    const erResult = yield* settingsHook
      .trigger(resultPayload, { sessionID, transcriptPath: "" })
      .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] })))
    yield* SettingsHook.landSystemMessages(erResult, { sessionID })
  }

  if (validated !== undefined) return { action: "accept", content: validated } satisfies ElicitResponse
  return { action: "decline" } satisfies ElicitResponse
})

/**
 * Register the elicitation handler on a connected MCP client. The handler is a
 * plain async function (Promise-returning) that bridges into the Effect world.
 */
export function registerElicitationHandler(client: Client, bridge: import("@/effect/bridge").EffectBridge.Shape) {
  // The handler receives the full JSON-RPC request `{ method, params: {...} }`;
  // the elicitation fields live under `params`. On 2026-era connections the
  // client drives input_required retries through this same handler.
  const handler = async (request: { params?: { message?: string; requestedSchema?: unknown; mode?: string } }) => {
    const params = request.params ?? {}
    const sessionID = SessionContext.sessionID ?? activeSession.at(-1)?.id
    const response = await bridge.promise(
      handleElicitation({
        message: params.message ?? "",
        requestedSchema: params.requestedSchema,
        mode: params.mode,
        sessionID,
      }),
    )
    return response
  }
  client.setRequestHandler("elicitation/create", handler as never)
}
