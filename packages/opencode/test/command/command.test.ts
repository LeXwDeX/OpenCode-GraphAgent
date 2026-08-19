import { describe, expect } from "bun:test"
import { CommandPlugin } from "@opencode-ai/core/plugin/command"
import { Effect, Layer } from "effect"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"
import { SessionPrompt } from "@/session/prompt"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

function commandLayer(commands: Record<string, { template: string; description?: string }> = {}) {
  return Layer.mergeAll(
    Command.layer.pipe(
      Layer.provide(
        Layer.mock(Config.Service, {
          get: () => Effect.succeed({ command: commands } as never),
        }),
      ),
      Layer.provide(
        Layer.mock(MCP.Service, {
          prompts: () => Effect.succeed({}),
        }),
      ),
      Layer.provide(
        Layer.mock(Skill.Service, {
          all: () => Effect.succeed([]),
        }),
      ),
    ),
    testInstanceStoreLayer,
  )
}

const it = testEffect(commandLayer())
const overridden = testEffect(
  commandLayer({
    "dag-flow": {
      description: "Custom DAG flow",
      template: "Custom task:\n$ARGUMENTS",
    },
  }),
)

describe("legacy command registry", () => {
  it.instance("lists MEMORY as a controller command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service

      expect(yield* commands.get("memory")).toMatchObject({
        name: "memory",
        source: "command",
        template: "",
        hints: ["$ARGUMENTS"],
      })
    }),
  )

  it.instance("registers the canonical dag-flow command without a built-in workflow fallback", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const command = yield* commands.get("dag-flow")

      expect(command).toMatchObject({
        name: "dag-flow",
        description: CommandPlugin.DagFlowDescription,
        source: "command",
        template: CommandPlugin.DagFlowContent,
        hints: ["$ARGUMENTS"],
      })
      expect(yield* commands.get("workflow")).toBeUndefined()
    }),
  )

  it.instance("registers the canonical dag-template-update command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service

      expect(yield* commands.get("dag-template-update")).toMatchObject({
        name: "dag-template-update",
        description: CommandPlugin.DagTemplateUpdateDescription,
        source: "command",
        template: CommandPlugin.DagTemplateUpdateContent,
        hints: ["$ARGUMENTS"],
      })
    }),
  )

  it.instance("registers the canonical dag-init and dag-auto commands", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service

      expect(yield* commands.get("dag-init")).toMatchObject({
        name: "dag-init",
        description: CommandPlugin.DagInitDescription,
        source: "command",
        template: CommandPlugin.DagInitContent,
        hints: ["$ARGUMENTS"],
      })
      expect(yield* commands.get("dag-auto")).toMatchObject({
        name: "dag-auto",
        description: CommandPlugin.DagAutoDescription,
        source: "command",
        template: CommandPlugin.DagAutoContent,
        hints: ["$ARGUMENTS"],
      })
    }),
  )

  overridden.instance("allows configured dag-flow commands to override the built-in", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      expect(yield* commands.get("dag-flow")).toMatchObject({
        description: "Custom DAG flow",
        template: "Custom task:\n$ARGUMENTS",
      })
    }),
  )

  it.effect("preserves complete multi-line command arguments", () =>
    Effect.sync(() => {
      const input = "Investigate auth\nThen run the focused tests"
      const expanded = SessionPrompt.expandCommandTemplate(CommandPlugin.DagFlowContent, input)

      expect(expanded).toContain(`<dag-flow-task>\n${input}\n</dag-flow-task>`)
      expect(expanded).not.toContain("$ARGUMENTS")
    }),
  )

  it.effect("returns after starting a DAG instead of polling its status", () =>
    Effect.sync(() => {
      const expanded = SessionPrompt.expandCommandTemplate(CommandPlugin.DagFlowContent, "Run two parallel workers")

      expect(expanded).toContain("Do not poll")
      expect(expanded).toContain("and end the response")
    }),
  )

  it.effect("requires router-driven compilation without dropping task constraints", () =>
    Effect.sync(() => {
      const expanded = SessionPrompt.expandCommandTemplate(
        CommandPlugin.DagFlowContent,
        "Use @security-reviewer to review this project. Do not modify files.",
      )

      expect(expanded).toContain("resident Orchestration Router")
      expect(expanded).not.toContain('workflow(action="list")')
      expect(expanded).not.toContain('workflow(action="read"')
      expect(expanded).toMatch(/Preserve\s+the task,\s+user constraints/)
      expect(expanded).toContain("worker types or model IDs")
      expect(expanded).toContain("configured capability or model")
      expect(expanded).toContain("real error")
      expect(expanded).toContain("final synthesis block must contain the requested result")
    }),
  )

  it.effect("keeps the blank-task guard when dag-flow has no arguments", () =>
    Effect.sync(() => {
      const expanded = SessionPrompt.expandCommandTemplate(CommandPlugin.DagFlowContent, "   ")

      expect(expanded).toContain("<dag-flow-task>\n   \n</dag-flow-task>")
      expect(expanded).toContain("empty or contains only whitespace")
      expect(expanded).toContain("do not start a workflow")
    }),
  )
})
