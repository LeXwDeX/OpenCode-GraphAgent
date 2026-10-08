import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"
import path from "node:path"
import { SessionTools } from "@/session/tools"
import { SessionHooks } from "@/hook/session-hooks"
import { SettingsHook } from "@/hook/settings"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { ToolRegistry } from "@/tool/registry"
import { Plugin } from "@/plugin"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { TestInstance } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

// A PreToolUse `permissionDecision:"ask"` must always surface a dialog, even when
// the agent's ruleset is a wildcard deny with pattern-scoped allows (plan agent
// style). The tool's own permission request — with the real pattern — still
// enforces deny rules after the user approves the hook ask.

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
const hookLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)

let directory = ""
const editDefinition = {
  id: "edit",
  description: "Fixture edit tool that requests the real path pattern",
  parameters: Schema.Struct({ filePath: Schema.String }),
  execute: (args: { filePath: string }, ctx: Tool.Context) =>
    ctx
      .ask({ permission: "edit", patterns: [path.relative(directory, args.filePath)], always: ["*"], metadata: {} })
      .pipe(Effect.as({ title: "edited", output: "EDIT_COMPLETE", metadata: {} })),
}
const bashDefinition = {
  id: "bash",
  description: "Fixture bash tool that requests the real command pattern",
  parameters: Schema.Struct({ command: Schema.String }),
  execute: (args: { command: string }, ctx: Tool.Context) =>
    ctx
      .metadata({ title: "running", metadata: {} })
      .pipe(
        Effect.andThen(ctx.ask({ permission: "bash", patterns: [args.command], always: ["*"], metadata: {} })),
        Effect.as({ title: "ran", output: `BASH_COMPLETE ${args.command}`, metadata: {} }),
      ),
}
// Tool-part inputs recorded through ctx.metadata, in call order.
const recordedInputs: unknown[] = []
const it = testEffect(
  Layer.mergeAll(
    Permission.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provideMerge(hookLayer)),
    Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
    Layer.mock(Truncate.Service, {}),
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed([editDefinition, bashDefinition]),
      registrations: () =>
        Effect.succeed([
          { definition: editDefinition, sourceKind: "host-builtin", registrationID: "test:edit" },
          { definition: bashDefinition, sourceKind: "host-builtin", registrationID: "test:bash" },
        ]),
    }),
  ),
)

const PLAN_RULES = [
  { permission: "edit", pattern: "*", action: "deny" as const },
  { permission: "edit", pattern: ".opencode/plans/*.md", action: "allow" as const },
  { permission: "bash", pattern: "*", action: "deny" as const },
  { permission: "bash", pattern: "git *", action: "allow" as const },
]

type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }

const setupWith = (hookOutput: Record<string, unknown>, agentName: string, rules: Rule[]) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    directory = instance.directory
    const store = yield* SessionHooks.Service
    const id = SessionID.descending()
    yield* store.add(id, {
      event: "PreToolUse",
      hooks: [{ type: "command", command: "printf '%s' " + quote(JSON.stringify(hookOutput)) }],
    })
    const tools = yield* SessionTools.resolve({
      agent: { name: agentName, permission: rules, options: {} } as any,
      model: ProviderTest.model(),
      session: { id, directory, permission: [] } as any,
      processor: {
        message: { id: MessageID.ascending(), sessionID: id },
        updateToolCall: (
          _callID: string,
          update: (match: { state: { status: string } }) => { state: { input?: unknown } },
        ) =>
          Effect.sync(() => {
            recordedInputs.push(update({ state: { status: "running" } }).state.input)
          }),
        completeToolCall: () => Effect.void,
      } as any,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as any,
    })
    return { tools: tools as Record<string, any>, directory }
  })

const setup = setupWith(
  {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "confirm" },
  },
  "plan",
  PLAN_RULES,
)

// Runs the tool, approves the hook's confirmation dialog once, returns the tool exit.
const runApprovingHookAsk = (tools: Record<string, any>, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* Effect.tryPromise(() =>
      tools[name].execute(args, {
        toolCallId: `call-${name}`,
        messages: [],
        abortSignal: new AbortController().signal,
      }),
    ).pipe(Effect.forkScoped)
    const pending = yield* pollWithTimeout(
      permission.list().pipe(Effect.map((list) => (list.length > 0 ? list : undefined))),
      "hook ask did not surface a permission dialog",
    )
    expect(pending).toHaveLength(1)
    expect(pending[0].metadata).toMatchObject({ hookAsk: true })
    yield* permission.reply({ requestID: pending[0].id, reply: "once" })
    return yield* Fiber.await(fiber)
  })

describe("hook permissionDecision ask with pattern-scoped rulesets", () => {
  it.instance("Edit ask prompts despite a wildcard deny; the allowed plan path then runs", () =>
    Effect.gen(function* () {
      const { tools, directory } = yield* setup
      const exit = yield* runApprovingHookAsk(tools, "edit", {
        filePath: path.join(directory, ".opencode", "plans", "a.md"),
      })
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(JSON.stringify(exit.value)).toContain("EDIT_COMPLETE")
    }),
  )

  it.instance("Edit ask approval does not bypass a deny on the real path", () =>
    Effect.gen(function* () {
      const { tools, directory } = yield* setup
      const exit = yield* runApprovingHookAsk(tools, "edit", { filePath: path.join(directory, "src", "a.ts") })
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* Permission.Service.use((p) => p.list())).length).toBe(0)
    }),
  )

  it.instance("Bash ask prompts despite a wildcard deny; allowed and denied commands", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup
      const allowed = yield* runApprovingHookAsk(tools, "bash", { command: "git status" })
      expect(Exit.isSuccess(allowed)).toBe(true)
      const denied = yield* runApprovingHookAsk(tools, "bash", { command: "curl example.com" })
      expect(Exit.isFailure(denied)).toBe(true)
    }),
  )
})

// The user confirms exactly what will run: a hook-rewritten input is shown in the forced dialog, and that
// confirmation settles the tool's own ask-level check for the same call. Deny rules still apply.
const setupRewrite = (rules: Rule[]) =>
  setupWith(
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "rewritten command",
        updatedInput: { command: "git log --oneline" },
      },
    },
    "build",
    rules,
  ).pipe(Effect.map((result) => result.tools))

describe("hook permissionDecision ask confirms the effective input once", () => {
  it.instance("shows the rewritten input and reason, then runs without a second dialog", () =>
    Effect.gen(function* () {
      const tools = yield* setupRewrite([{ permission: "bash", pattern: "*", action: "ask" }])
      const permission = yield* Permission.Service
      const fiber = yield* Effect.tryPromise(() =>
        tools.bash.execute(
          { command: "make clean" },
          { toolCallId: "call-rewrite", messages: [], abortSignal: new AbortController().signal },
        ),
      ).pipe(Effect.forkScoped)
      const pending = yield* pollWithTimeout(
        permission.list().pipe(Effect.map((list) => (list.length > 0 ? list : undefined))),
        "hook ask did not surface a permission dialog",
      )
      expect(pending).toHaveLength(1)
      expect(pending[0].always).toEqual([])
      expect(pending[0].metadata).toMatchObject({
        hookAsk: true,
        reason: "rewritten command",
        input: { command: "git log --oneline" },
      })
      recordedInputs.length = 0
      yield* permission.reply({ requestID: pending[0].id, reply: "once" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(JSON.stringify(exit.value)).toContain("BASH_COMPLETE git log --oneline")
      // The tool part keeps the model's own input; the rewrite is what ran.
      expect(recordedInputs).toEqual([{ command: "make clean" }])
      expect((yield* permission.list()).length).toBe(0)
    }),
  )

  it.instance("a confirmed forced ask still loses to a deny rule on the effective input", () =>
    Effect.gen(function* () {
      const tools = yield* setupRewrite([
        { permission: "bash", pattern: "*", action: "ask" },
        { permission: "bash", pattern: "git log *", action: "deny" },
      ])
      const exit = yield* runApprovingHookAsk(tools, "bash", { command: "echo hi" })
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
