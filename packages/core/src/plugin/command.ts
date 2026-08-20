/// <reference path="../markdown.d.ts" />

export * as CommandPlugin from "./command"

import { define } from "./internal"
import { Effect } from "effect"
import { Location } from "../location"
import PROMPT_INITIALIZE from "./command/initialize.txt"
import PROMPT_REVIEW from "./command/review.txt"
import DAG_FLOW_PROMPT from "./command/dag-flow.txt"
import DAG_TEMPLATE_UPDATE_PROMPT from "./command/dag-template-update.txt"
import DAG_INIT_PROMPT from "./command/dag-init.txt"
import DAG_AUTO_PROMPT from "./command/dag-auto.txt"
import workflowRouting from "./command/workflow-routing.md" with { type: "text" }
import workflowBlocks from "./command/workflow-blocks.md" with { type: "text" }
import workflowContent from "./command/workflow.md" with { type: "text" }
import orchestrationPolicy from "./command/orchestration-policy.md" with { type: "text" }
import orchestrationDomains from "./command/orchestration-domains.md" with { type: "text" }

export const DagFlowDescription = "Start a dependency-graph multi-agent workflow for the supplied task"
export const DagTemplateUpdateDescription = "Update the global DAG reference templates from opencode-dag-config"
export const DagInitDescription =
  "Connect this repo to GitHub/GitLab, verify issue/PR permissions, and prepare everything /dag-auto needs"
export const DagAutoDescription =
  "Finish it: drive the composed ultra-flow (exploration → design → development → acceptance → release → summary) to completion"
export const WorkflowFactsContent = workflowContent
export const WorkflowBlocksContent = workflowBlocks
export const OrchestrationPolicyContent = orchestrationPolicy
export const OrchestrationDomainsContent = orchestrationDomains
export const WorkflowContent = workflowRouting
export const DagFlowContent = DAG_FLOW_PROMPT
export const DagTemplateUpdateContent = DAG_TEMPLATE_UPDATE_PROMPT
export const DagInitContent = DAG_INIT_PROMPT
export const DagAutoContent = DAG_AUTO_PROMPT

export const Plugin = define({
  id: "command",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    yield* ctx.command.transform((draft) => {
      draft.update("init", (command) => {
        command.template = PROMPT_INITIALIZE.replace("${path}", location.project.directory)
        command.description = "guided AGENTS.md setup"
      })
      draft.update("review", (command) => {
        command.template = PROMPT_REVIEW.replace("${path}", location.project.directory)
        command.description = "review changes [commit|branch|pr], defaults to uncommitted"
        command.subtask = true
      })
      draft.update("dag-flow", (command) => {
        command.template = DagFlowContent
        command.description = DagFlowDescription
      })
      draft.update("dag-template-update", (command) => {
        command.template = DAG_TEMPLATE_UPDATE_PROMPT
        command.description = DagTemplateUpdateDescription
      })
      draft.update("dag-init", (command) => {
        command.template = DagInitContent
        command.description = DagInitDescription
      })
      draft.update("dag-auto", (command) => {
        command.template = DagAutoContent
        command.description = DagAutoDescription
      })
    })
  }),
})
