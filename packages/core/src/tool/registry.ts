export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ContextFoldingToolSourceLedger } from "../session/context-folding/tool-source-ledger"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import {
  contextFolding,
  definition,
  permission,
  settle,
  validateName,
  type AnyTool,
  type RegistrationError,
} from "./tool"
import { Tools } from "./tools"
import { ContextFoldingBuiltins } from "./context-folding-builtins"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
}

type Register = (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>

const registerContextFoldingBuiltin: unique symbol = Symbol("ToolRegistry.registerContextFoldingBuiltin")

export interface Interface {
  readonly materialize: (permissions?: PermissionV2.Ruleset) => Effect.Effect<Materialization>
  /** Ordinary Location registration. It never grants host-builtin provenance. */
  readonly register: Register
  /** Unavailable through the ordinary string-keyed service surface; exposed only through the host-internal layer below. */
  readonly [registerContextFoldingBuiltin]: Register
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    const sourceLedger = yield* ContextFoldingToolSourceLedger.Service
    type Registration = {
      readonly identity: object
      readonly tool: AnyTool
      readonly sourceKind: "host-builtin" | "custom"
      readonly registrationID: string
    }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const register = (sourceKind: Registration["sourceKind"], operation: string): Register =>
      Effect.fn(operation)(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [
                ...(local.get(name) ?? []),
                {
                  token,
                  registration: {
                    identity: {},
                    tool,
                    sourceKind,
                    registrationID: crypto.randomUUID(),
                  },
                },
              ])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      })

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (
      input: ExecuteInput,
      advertised?: Registration,
      registrationGeneration?: string,
    ) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised.identity)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      const source =
        advertised && registrationGeneration
          ? {
              sourceKind: advertised.sourceKind,
              registrationID: advertised.registrationID,
              registrationGeneration,
              instructions: contextFolding(advertised.tool).instructions,
            }
          : undefined
      if (source)
        yield* sourceLedger.record({
          sessionID: input.sessionID,
          assistantMessageID: input.assistantMessageID,
          callID: input.call.id,
          toolName: input.call.name,
          source,
        })
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    return Service.of({
      register: register("custom", "ToolRegistry.register"),
      [registerContextFoldingBuiltin]: register("host-builtin", "ToolRegistry.registerContextFoldingBuiltin"),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = []) {
        const registrations = new Map<string, Registration>(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)
        const ordered = [...registrations.entries()]
        const registrationGeneration = yield* sourceLedger.activate(
          ordered.map(([toolName, registration]) => ({
            toolName,
            sourceKind: registration.sourceKind,
            registrationID: registration.registrationID,
            instructions: contextFolding(registration.tool).instructions,
          })),
        )
        return {
          definitions: ordered.map(([name, registration]) => definition(name, registration.tool)),
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration, registrationGeneration)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
    })
  }),
)

const ledgerRegistryLayer = registryLayer.pipe(Layer.provideMerge(ContextFoldingToolSourceLedger.layer))

export const layer = Layer.mergeAll(
  Layer.effect(
    Tools.Service,
    Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
  ),
  Layer.effect(
    ContextFoldingBuiltins.Service,
    Service.use((registry) =>
      Effect.succeed(ContextFoldingBuiltins.Service.of({ register: registry[registerContextFoldingBuiltin] })),
    ),
  ),
).pipe(Layer.provideMerge(ledgerRegistryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const defaultLayer = layer.pipe(
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
)
