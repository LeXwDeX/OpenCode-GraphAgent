/// <reference path="../markdown.d.ts" />

export * as CommandPlugin from "./command"

import { define } from "./internal"
import { Effect } from "effect"
import { Location } from "../location"
import PROMPT_INITIALIZE from "./command/initialize.txt"
import PROMPT_REVIEW from "./command/review.txt"
import DAG_FLOW_PROMPT from "./command/dag-flow.txt"
import DAG_TEMPLATE_UPDATE_PROMPT from "./command/dag-template-update.txt"
import workflowRouting from "./command/workflow-routing.md" with { type: "text" }
import workflowBlocks from "./command/workflow-blocks.md" with { type: "text" }
import workflowContent from "./command/workflow.md" with { type: "text" }
import orchestrationPolicy from "./command/orchestration-policy.md" with { type: "text" }
import orchestrationDomains from "./command/orchestration-domains.md" with { type: "text" }

export const DagFlowDescription = "Start a dependency-graph multi-agent workflow for the supplied task"
export const DagTemplateUpdateDescription = "Update the global DAG reference templates from opencode-dag-config"
export const WorkflowFactsContent = workflowContent
export const WorkflowBlocksContent = workflowBlocks
export const OrchestrationPolicyContent = orchestrationPolicy
export const OrchestrationDomainsContent = orchestrationDomains
export const WorkflowContent = workflowRouting
export const DagFlowContent = DAG_FLOW_PROMPT

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
    })
  }),
})
