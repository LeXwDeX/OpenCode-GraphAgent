/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeContent from "./skill/customize-opencode.md" with { type: "text" }
import configureHooksContent from "./skill/configure-hooks.md" with { type: "text" }
import createDagWorkflowContent from "./skill/create-dag-workflow.md" with { type: "text" }
import orchestrationRouterContent from "./skill/orchestration-router.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent
export const ConfigureHooksContent = configureHooksContent
export const CreateDagWorkflowContent = createDagWorkflowContent
export const OrchestrationRouterContent = orchestrationRouterContent

export const CustomizeOpencodeDescription =
  "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself."

export const ConfigureHooksDescription =
  "Use when the user wants to automatically run something on an opencode event — before/after a tool call, on session start/end, on compaction, etc. — or asks about opencode's hooks / hooks.json / event hooks. Covers hooks.json file locations and format, the 27 supported events, and the 5 hook types (command, mcp, http, prompt, agent). Also use to migrate hooks from Claude Code's .claude/settings.json via /import-claude-hooks."

export const CreateDagWorkflowDescription =
  "Use when the user wants to create, save, or edit a reusable DAG workflow — a named multi-agent graph they can start again later — or asks where workflow specs live, how to make a workflow available in every project, or why a saved workflow name does not resolve. Covers project/global scopes, composable blocks, low-level nodes, and verification. Do not use to run an existing workflow or to design a one-off graph for the current task; the workflow tool handles those."

export const OrchestrationRouterDescription =
  "Use proactively in the user-facing parent session, without waiting for /dag-flow, whenever one objective changes project source or tests (even one project file), crosses module boundaries, needs repository-backed product/architecture planning, or has staged, parallel, quality-gated, or adaptive execution. Routes work through a parent-owned decision checkpoint and composable DAG blocks. Do not use inside a DAG child session, for one or two isolated utility scripts, simple lookup/conversation, or when the user explicitly requests direct work, one agent, or no DAG."

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-opencode",
            description: CustomizeOpencodeDescription,
            location: AbsolutePath.make("/builtin/customize-opencode.md"),
            content: CustomizeOpencodeContent,
          }),
        }),
      )
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "configure-hooks",
            description: ConfigureHooksDescription,
            location: AbsolutePath.make("/builtin/configure-hooks.md"),
            content: ConfigureHooksContent,
          }),
        }),
      )
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "create-dag-workflow",
            description: CreateDagWorkflowDescription,
            location: AbsolutePath.make("/builtin/create-dag-workflow.md"),
            content: CreateDagWorkflowContent,
          }),
        }),
      )
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "orchestration-router",
            description: OrchestrationRouterDescription,
            location: AbsolutePath.make("/builtin/orchestration-router.md"),
            content: OrchestrationRouterContent,
          }),
        }),
      )
    })
  }),
})
