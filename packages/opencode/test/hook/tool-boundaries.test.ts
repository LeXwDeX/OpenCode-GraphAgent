import { describe, expect } from "bun:test"
import { Effect, Layer, Schema, Cause } from "effect"
import fs from "node:fs/promises"
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
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { buildAgentTools } from "@/hook/agent-tools"

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
const jsonCommand = (json: unknown) => "printf '%s' " + quote(JSON.stringify(json))
const hookLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const writeDefinition = {
  id: "write",
  description: "Fixture leaf writer with the real write tool parameter shape",
  parameters: Schema.Struct({ filePath: Schema.String, content: Schema.String }),
  execute: (args: { filePath: string; content: string }) =>
    Effect.promise(async () => {
      await fs.writeFile(args.filePath, args.content)
      return { title: "written", output: "WRITE_COMPLETE", metadata: {} }
    }),
}
const layers = Layer.mergeAll(
  hookLayer,
  Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
  Layer.mock(Permission.Service, { ask: () => Effect.void }),
  Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
  Layer.mock(Truncate.Service, {}),
  Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed([writeDefinition]) }),
)
const it = testEffect(layers)
const resolve = (id: any, dir: string) =>
  SessionTools.resolve({
    agent: { name: "build", permission: [], options: {} } as any,
    model: ProviderTest.model(),
    session: { id, directory: dir, permission: [] } as any,
    processor: {
      message: { id: MessageID.ascending(), sessionID: id },
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    } as any,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as any,
  })
const execute = (tools: any, filePath: string) =>
  Effect.promise(() =>
    tools.write.execute(
      { filePath, content: "audit-safe-fixture" },
      { toolCallId: "audit-write", messages: [], abortSignal: new AbortController().signal },
    ),
  )

describe("real SessionTools call path", () => {
  it.instance("FileChanged envelope must contain native filePath", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const capture = path.join(instance.directory, "filechanged.json")
      const target = path.join(instance.directory, "changed.txt")
      yield* store.add(id, { event: "FileChanged", hooks: [{ type: "command", command: "cat > " + quote(capture) }] })
      const tools = yield* resolve(id, instance.directory)
      yield* execute(tools, target)
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("audit-safe-fixture")
      const envelope = JSON.parse(yield* Effect.promise(() => fs.readFile(capture, "utf8")))
      expect(envelope.path).toBe(target)
    }),
  )

  it.instance("PostToolUse block reason must be visible to the model", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "PostToolUse",
        hooks: [{ type: "command", command: jsonCommand({ decision: "block", reason: "AUDIT_POST_REJECT" }) }],
      })
      const tools = yield* resolve(id, instance.directory)
      const result = yield* execute(tools, path.join(instance.directory, "changed.txt"))
      expect(JSON.stringify(result)).toContain("AUDIT_POST_REJECT")
    }),
  )

  it.instance("malformed hook output must not fail the tool execution", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "PreToolUse",
        hooks: [{ type: "command", command: jsonCommand({ hookSpecificOutput: "broken" }) }],
      })
      const tools = yield* resolve(id, instance.directory)
      const result = yield* execute(tools, path.join(instance.directory, "changed.txt")).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
    }),
  )
})

const agent = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, FSUtil.defaultLayer))
describe("agent tool runtime boundary", () => {
  agent.instance("read-only agent bash must not create a file using a newline", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const spawner = yield* ChildProcessSpawner
      const filesystem = yield* FSUtil.Service
      const tools = buildAgentTools({
        spawner,
        fs: filesystem,
        cwd: instance.directory,
        signal: new AbortController().signal,
        captured: { value: null },
      })
      const marker = path.join(instance.directory, "unauthorized-marker")
      const result = yield* Effect.promise(() =>
        Promise.resolve(
          tools.bash.execute!({ command: "echo harmless\ntouch " + quote(marker) }, {
            toolCallId: "audit",
            messages: [],
          } as any),
        ),
      )
      const exists = yield* Effect.promise(() =>
        fs.access(marker).then(
          () => true,
          () => false,
        ),
      )
      expect(JSON.stringify(result)).toContain("Error:")
      expect(exists).toBe(false)
    }),
  )

  agent.instance("agent bash must stop after its abort signal", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const spawner = yield* ChildProcessSpawner
      const filesystem = yield* FSUtil.Service
      const ac = new AbortController()
      const input = path.join(instance.directory, "follow.txt")
      yield* Effect.promise(() => fs.writeFile(input, "ready\n"))
      let pid: number | undefined
      let ready!: () => void
      const started = new Promise<void>((resolve) => {
        ready = resolve
      })
      const observed = {
        ...spawner,
        spawn: (...args: Parameters<typeof spawner.spawn>) =>
          spawner.spawn(...args).pipe(
            Effect.tap((handle) =>
              Effect.sync(() => {
                pid = Number(handle.pid)
                ready()
              }),
            ),
          ),
      }
      const tools = buildAgentTools({
        spawner: observed,
        fs: filesystem,
        cwd: instance.directory,
        signal: ac.signal,
        captured: { value: null },
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => ac.abort()))
      const task = Promise.resolve(
        tools.bash.execute!(
          { command: "tail -f " + quote(input) },
          { toolCallId: "cancel", messages: [], abortSignal: ac.signal },
        ),
      )
      yield* Effect.promise(() => started).pipe(Effect.timeout(2000))
      ac.abort()
      const result = yield* Effect.promise(() => task).pipe(Effect.timeout(3000))
      expect(JSON.stringify(result)).toContain("Error:")
      expect(pid).toBeDefined()
      expect(() => process.kill(pid!, 0)).toThrow()
    }),
  )
})

const permission = testEffect(
  Permission.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provideMerge(hookLayer)),
)
describe("permission hook call path", () => {
  for (const variant of ["deny", "exit2"] as const) {
    permission.instance(`PermissionRequest ${variant} should resolve rejection without user input`, () =>
      Effect.gen(function* () {
        const store = yield* SessionHooks.Service
        const permissions = yield* Permission.Service
        const id = SessionID.descending()
        const command =
          variant === "deny"
            ? jsonCommand({ hookSpecificOutput: { hookEventName: "PermissionRequest", permissionDecision: "deny" } })
            : "printf '%s' 'AUDIT_PERMISSION_BLOCK' >&2; exit 2"
        yield* store.add(id, { event: "PermissionRequest", hooks: [{ type: "command", command }] })
        const exit = yield* permissions
          .ask({
            sessionID: id,
            permission: "bash",
            patterns: ["echo test"],
            always: [],
            metadata: {},
            ruleset: [],
          })
          .pipe(Effect.timeout(150), Effect.exit)
        const error = exit._tag === "Failure" ? Cause.pretty(exit.cause) : "success"
        expect(error).not.toContain("Timeout")
        expect(exit._tag).toBe("Failure")
        expect(yield* permissions.list()).toHaveLength(0)
        if (variant === "exit2") expect(error).toContain("AUDIT_PERMISSION_BLOCK")
      }),
    )
  }
})
