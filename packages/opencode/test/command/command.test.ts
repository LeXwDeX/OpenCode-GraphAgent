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
      expect(expanded).toContain("End the current response")
    }),
  )

  it.effect("requires profile-aware compilation without dropping task constraints", () =>
    Effect.sync(() => {
      const expanded = SessionPrompt.expandCommandTemplate(
        CommandPlugin.DagFlowContent,
        "Use @security-reviewer to review this project. Do not modify files.",
      )

      expect(expanded).toContain("classify the task as `brainstorm`, `review`, or `develop`")
      expect(expanded).toContain("preserve every user constraint")
      expect(expanded).toContain("eligible configured worker types")
      expect(expanded).toContain("Do not invent a missing role or model")
      expect(expanded).toContain("actual error")
      expect(expanded).toContain("must actually contain the requested synthesis")
    }),
  )

  it.effect("keeps the blank-task guard when dag-flow has no arguments", () =>
    Effect.sync(() => {
      const expanded = SessionPrompt.expandCommandTemplate(CommandPlugin.DagFlowContent, "   ")

      expect(expanded).toContain("<dag-flow-task>\n   \n</dag-flow-task>")
      expect(expanded).toContain("empty or contains only whitespace")
      expect(expanded).toContain("Do not call the `workflow` tool")
    }),
  )
})
