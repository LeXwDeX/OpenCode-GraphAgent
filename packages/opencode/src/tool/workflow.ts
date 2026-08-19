// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Tool } from "./tool"
import { CommandPlugin } from "@opencode-ai/core/plugin/command"
import { Effect, Option, Schema } from "effect"
import { Dag } from "@/dag/dag"
import { DagReviewLifecycle } from "@/dag/review-lifecycle"
import { DagWorkflows } from "@/dag/workflows"
import { DagValidation, type Diagnostic } from "@/dag/validation"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagEnvironmentCatalogs } from "@/dag/environment-catalogs"
import { Agent } from "@/agent/agent"
import { Question } from "@/question"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { createAdmissionRecord } from "@/dag/admission"
import { isOutputFileRef } from "@/dag/runtime/output-ref"
import { TerminalViolationError } from "@opencode-ai/core/dag/core/types"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { stringify as yamlStringify } from "yaml"
import { assertExternalDirectoryEffect } from "./external-directory"
import path from "node:path"

const id = "workflow"
const MAX_WORKFLOW_SPEC_BYTES = 1_000_000
const DEFAULT_RESULT_PAGE_CHARS = 8_000
const MAX_RESULT_PAGE_CHARS = 12_000

class ResultCursor extends Schema.Class<ResultCursor>("WorkflowResultCursor")({
  version: Schema.Literal(1),
  workflow_id: Dag.ID,
  node_id: Dag.NodeID,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

const ResultCursorJSON = Schema.fromJsonString(ResultCursor)
const ResultCursorToken = Schema.String.pipe(Schema.brand("WorkflowResultCursorToken"))
type ResultCursorToken = typeof ResultCursorToken.Type
const decodeResultCursor = Schema.decodeUnknownOption(ResultCursorJSON)

// Exported so the committed workflow library can be validated in tests.
export const StartSpec = DagValidation.StartSpec
// Distinct re-export for test files that import multiple tools' Parameters
// without aliasing (the repo forbids import aliases).
export { Parameters as WorkflowParameters }

// ============================================================================
// Parameters: a single `params` root property carrying the action union.
// OpenAI's tools contract expects `parameters` to be a JSON Schema object; a
// root-level combinator (anyOf/oneOf/allOf) is outside that contract and
// OpenAI-compatible backends reject it — DeepSeek with an explicit schema
// error, GLM by silently emitting empty tool arguments. Nesting the union one
// level down keeps every discriminated branch intact while the schema root
// stays a plain object on every transport.
// ============================================================================

const specPathDescription =
  '(start/extend/control replan/read/validate) An exact saved workflow name returned by workflow(action="list"), or a path to a YAML workflow spec. Graph content belongs in that file; relative paths resolve from the session directory'

const StartPath = Schema.Struct({
  action: Schema.Literal("start").annotate({ description: "Create a workflow" }),
  spec_path: Schema.String.annotate({ description: specPathDescription }),
})
const ExtendPath = Schema.Struct({
  action: Schema.Literal("extend").annotate({ description: "Add nodes or blocks to a live workflow" }),
  workflow_id: Dag.ID.annotate({ description: "Target workflow ID" }),
  spec_path: Schema.String.annotate({ description: specPathDescription }),
})
const ControlReplanPath = Schema.Struct({
  action: Schema.Literal("control").annotate({ description: "Control a live workflow" }),
  operation: Schema.Literal("replan").annotate({ description: "Apply a node fragment (add/cancel/restart/replace)" }),
  workflow_id: Dag.ID.annotate({ description: "Target workflow ID" }),
  spec_path: Schema.String.annotate({ description: specPathDescription }),
})
const ControlOther = Schema.Struct({
  action: Schema.Literal("control").annotate({ description: "Control a live workflow" }),
  operation: Schema.Literals(["pause", "resume", "cancel", "step", "complete"]).annotate({
    description: "pause/resume/cancel/step/complete",
  }),
  workflow_id: Dag.ID.annotate({ description: "Target workflow ID" }),
})
const Status = Schema.Struct({
  action: Schema.Literal("status").annotate({ description: "Inspect durable workflow and node state" }),
  workflow_id: Dag.ID.annotate({ description: "Target workflow ID" }),
})
const Result = Schema.Struct({
  action: Schema.Literal("result").annotate({ description: "Read one durable node output in bounded pages" }),
  workflow_id: Dag.ID.annotate({ description: "Target workflow ID" }),
  node_id: Dag.NodeID.annotate({ description: "Target durable node ID" }),
  cursor: Schema.optional(ResultCursorToken).annotate({
    description: "Opaque continuation cursor returned by the previous page",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_RESULT_PAGE_CHARS }))).annotate({
    description: `Maximum page characters; defaults to ${DEFAULT_RESULT_PAGE_CHARS}, max ${MAX_RESULT_PAGE_CHARS}`,
  }),
})
const List = Schema.Struct({
  action: Schema.Literal("list").annotate({
    description: "Show saved workflow names, objectives, sizes, scopes, and validation status",
  }),
})
const Read = Schema.Struct({
  action: Schema.Literal("read").annotate({ description: "Inspect one saved spec before retargeting it" }),
  spec_path: Schema.String.annotate({ description: specPathDescription }),
})
const Guide = Schema.Struct({
  action: Schema.Literal("guide").annotate({ description: "Load detailed guidance only when needed" }),
  topic: Schema.optional(Schema.Literals(["blocks", "interface", "policy", "patterns"])).annotate({
    description:
      "blocks: composable block schema; interface: low-level workflow API; policy: gates/admission/recovery; patterns: domain playbooks. Omit for the compact index",
  }),
})
const Draft = Schema.Struct({
  action: Schema.Literal("draft").annotate({
    description:
      'Render a structured graph into a validated YAML spec file and return its spec_path — no workflow is created. Preferred over hand-writing YAML: field names are schema-checked here, eliminating serialization drift',
  }),
  title: Schema.optional(Schema.String).annotate({ description: "Optional workflow title" }),
  config: DagValidation.WorkflowGraphSchema.annotate({
    description:
      'Exactly one graph shape: { name, objective, blocks: [{ id, kind, depends_on?, instruction?, worker_type?, required?, report_to_parent? }], node_defaults?, max_concurrency?, max_node_replan_attempts?, max_total_nodes? } or the low-level { name, nodes: [...] } form. Fields are exhaustive — no others exist',
  }),
})
const ValidationProfile = Schema.optional(Schema.Literals(["portable", "environment"])).annotate({
  description:
    "portable: distributable-template checks; environment: additionally resolves prompts, workers, and models in this project. Defaults: builtin specs portable, project/global/path specs environment",
})
const ValidatePath = Schema.Struct({
  action: Schema.Literal("validate").annotate({
    description: "Pre-flight a custom spec without creating a workflow; returns diagnostics, never a workflow ID",
  }),
  spec_path: Schema.String.annotate({ description: specPathDescription }),
  profile: ValidationProfile,
})

const ActionParams = Schema.Union([
  StartPath,
  ExtendPath,
  ControlReplanPath,
  ControlOther,
  Status,
  Result,
  List,
  Read,
  Guide,
  Draft,
  ValidatePath,
])

export const Parameters = Schema.Struct({
  params: ActionParams.annotate({ description: "The workflow action and its action-owned fields" }),
})

// ============================================================================
// Tool definition
// ============================================================================

type Metadata = {
  workflowId?: Dag.ID
  nodeId?: Dag.NodeID
  truncated?: boolean
  nextCursor?: ResultCursorToken
  added?: string[]
  cancel?: string[]
  restart?: string[]
  replace?: string[]
}

type AuthoringSource = Parameters<ReturnType<typeof WorkflowAuthoring.make>["prepare"]>[0]["source"]

export const WorkflowTool = Tool.define<
  typeof Parameters,
  Metadata,
  Dag.Service | Session.Service | Agent.Service | Question.Service | Provider.Service
>(
  id,
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service

    const requireOwnedWorkflow = Effect.fn("WorkflowTool.requireOwnedWorkflow")(function* (
      workflowID: Dag.ID,
      sessionID: string,
    ) {
      const workflow = yield* dag.store.getWorkflow(workflowID).pipe(Effect.orDie)
      if (!workflow || workflow.sessionId !== sessionID) {
        return yield* Effect.die(new Error(`Workflow not found: ${workflowID}`))
      }
      return workflow
    })

    const rejectDiagnostics = (diagnostics: Diagnostic[], context: string) =>
      Effect.die(
        new Error(
          `${context} rejected by workflow validation:\n${diagnostics
            .map((d) => `- [${d.code}] ${d.path}: ${d.message}${d.hint ? ` (${d.hint})` : ""}`)
            .join("\n")}`,
        ),
      )

    const authoring = WorkflowAuthoring.make({
      loadEnvironment: DagEnvironmentCatalogs.makeCatalogLoader(agents, provider),
    })

    const portableEntryCheck = (entry: DagWorkflows.Entry) =>
      Effect.gen(function* () {
        const content = yield* Effect.promise(() => entryContent(entry))
        if (content === undefined) {
          return { valid: false, summary: "[schema.invalid] spec content is unreadable" }
        }
        const result = yield* authoring.prepare({
          action: "start",
          source: { kind: "yaml", source: entry.path, content },
          profile: "portable",
        })
        const summary = result.valid
          ? ""
          : result.errors
              .slice(0, 3)
              .map((d) => `[${d.code}] ${d.path}: ${d.message}`)
              .join("; ")
        return { valid: result.valid, summary }
      })

    return {
      description: CommandPlugin.WorkflowContent,
      parameters: Parameters,
      parseOptions: { onExcessProperty: "error" },
      formatValidationError: (error) =>
        [
          `Workflow call rejected by the action schema: ${error instanceof Error ? error.message : String(error)}`,
          'The call takes a single { params } object: params { action, ...action-owned fields } where each action owns only its own fields: start {spec_path}; extend {workflow_id, spec_path}; control(replan) {workflow_id, operation, spec_path}; other control operations {workflow_id, operation}; status {workflow_id}; result {workflow_id, node_id, cursor?, limit?}; list {}; read {spec_path}; guide {topic?}; draft {title?, config}; validate {spec_path, profile?}. Put graph content in draft (structured, schema-checked) or a .yaml/.yml file; session/project identity is never a parameter.',
        ].join("\n"),
      execute: (call: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const params = call.params
          const callingSession = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
          if (callingSession.parentID) {
            return yield* Effect.die(
              new Error("Workflow orchestration is available only to the main conversation, not child agents"),
            )
          }
          yield* ctx.ask({
            permission: id,
            patterns: [params.action],
            always: ["*"],
            metadata: {
              action: params.action,
              ...("workflow_id" in params ? { workflow_id: params.workflow_id } : {}),
              ...("node_id" in params ? { node_id: params.node_id } : {}),
              ...("operation" in params ? { operation: params.operation } : {}),
            },
          })
          switch (params.action) {
            case "guide": {
              if (!params.topic) {
                return {
                  title: "Workflow guide topics",
                  output: [
                    "Load only the topic needed for the current decision:",
                    "- blocks: compose explore/plan/prototype/debug/coding/verify/review/synthesize blocks",
                    "- interface: low-level node fields, bindings, model resolution, and tool actions",
                    "- policy: deep admission, gates, checkpoints, recovery, and bounded repair",
                    "- patterns: cross-domain composition and route conflicts",
                  ].join("\n"),
                  metadata: {},
                }
              }
              const content = {
                blocks: CommandPlugin.WorkflowBlocksContent,
                interface: CommandPlugin.WorkflowFactsContent,
                policy: CommandPlugin.OrchestrationPolicyContent,
                patterns: CommandPlugin.OrchestrationDomainsContent,
              }[params.topic]
              return {
                title: `Workflow guide: ${params.topic}`,
                output: content,
                metadata: {},
              }
            }
            case "draft": {
              const specPath = yield* writeDraftSpec(params.config, params.title, callingSession.directory).pipe(
                Effect.orDie,
              )
              const result = yield* authoring.prepare({
                action: "start",
                source: { kind: "yaml", source: specPath, content: yield* readDraftSpec(specPath).pipe(Effect.orDie) },
                profile: "portable",
              })
              if (!result.valid) {
                return {
                  title: `Workflow draft written with validation errors: ${params.config.name}`,
                  output: [
                    `spec_path: ${specPath}`,
                    "The file is on disk; fix the errors by calling draft again with corrected fields. Diagnostics:",
                    ...result.errors.map((d) => `- [${d.code}] ${d.path}: ${d.message}${d.hint ? ` (${d.hint})` : ""}`),
                  ].join("\n"),
                  metadata: {},
                }
              }
              return {
                title: `Workflow draft valid: ${params.config.name}`,
                output: [
                  `spec_path: ${specPath}`,
                  `nodes: ${result.nodes.length}`,
                  'Next: workflow(action="start", spec_path) — or extend the file first for low-level fields, then start.',
                ].join("\n"),
                metadata: {},
              }
            }
            case "list": {
              const entries = yield* DagWorkflows.list(callingSession.directory)
              if (entries.length === 0) {
                return {
                  title: "No saved workflows",
                  output: `The workflow library is empty. Searched ${searchedScopes(callingSession.directory)}. Save a spec as <name>.yaml in one of those directories to start it later by name.`,
                  metadata: {},
                }
              }
              const rows: string[] = []
              for (const entry of entries) {
                const check = yield* portableEntryCheck(entry)
                rows.push(
                  [
                    `${entry.name} [${entry.scope}]${check.valid ? "" : " [invalid — not startable]"}`,
                    entry.title ? ` — ${entry.title}` : "",
                    entry.nodes !== undefined
                      ? ` (${entry.nodes} nodes)`
                      : entry.blocks !== undefined
                        ? ` (${entry.blocks} blocks)`
                        : "",
                    entry.objective ? `\n  objective: ${entry.objective}` : "",
                    `\n  path: ${entry.path}`,
                    check.valid ? "" : `\n  ${check.summary}`,
                  ].join(""),
                )
              }
              return {
                title: `${entries.length} saved workflow${entries.length > 1 ? "s" : ""}`,
                output: rows.join("\n"),
                metadata: {},
              }
            }
            case "read": {
              const specFile = yield* loadSpecFile(params.spec_path, callingSession.directory, ctx).pipe(Effect.orDie)
              const validation = yield* authoring.prepare({
                action: "start",
                source: { kind: "yaml", source: specFile.path, content: specFile.content },
                profile: "portable",
              })
              return {
                title: `Workflow spec: ${params.spec_path}`,
                output: JSON.stringify(
                  {
                    spec: validation.document,
                    validation: {
                      valid: validation.valid,
                      errors: validation.errors,
                      warnings: validation.warnings,
                    },
                  },
                  null,
                  2,
                ),
                metadata: {},
              }
            }
            case "validate": {
              const loaded = yield* loadSpecFile(params.spec_path, callingSession.directory, ctx).pipe(
                Effect.map((file) => ({
                  path: file.path,
                  source: { kind: "yaml" as const, source: file.path, content: file.content },
                })),
                Effect.catch((error: unknown) =>
                  Effect.succeed({
                    path: params.spec_path,
                    loadError: error instanceof Error ? error.message : String(error),
                  }),
                ),
              )
              const profile = params.profile ?? (DagWorkflows.isBuiltinPath(loaded.path) ? "portable" : "environment")
              const result =
                "loadError" in loaded
                  ? {
                      source: loaded.path,
                      profile,
                      valid: false,
                      errors: [
                        DagValidation.diagnostic({
                          code: DagValidation.DIAGNOSTIC_CODES.schemaInvalid,
                          path: loaded.path,
                          message: loaded.loadError,
                          hint: "Verify the workflow name or YAML file path",
                        }),
                      ],
                      warnings: [],
                      nodes: [],
                    }
                  : yield* authoring.prepare({
                      action: "start",
                      source: loaded.source,
                      profile,
                      environment: { directory: callingSession.directory, parent: callingSession.model },
                    })
              return {
                title: `Workflow validation ${result.valid ? "passed" : "failed"}: ${loaded.path} (${profile})`,
                output: JSON.stringify(validationOutput(result), null, 2),
                metadata: {},
              }
            }
            case "status": {
              const workflow = yield* requireOwnedWorkflow(params.workflow_id, ctx.sessionID)
              // Rev-view (v1.0.15 Train A): status is a view seam — it shows
              // the CURRENT graph revision only. Superseded replaced segments
              // stay reachable via the result seam (getNode is unfiltered).
              const nodes = yield* dag.store.getCurrentNodes(params.workflow_id).pipe(Effect.orDie)
              const config = Dag.parseWorkflowConfig(workflow.config)
              // A completed graph can still carry an unresolved review verdict
              // (REJECT checkpoint, issue #294); surface it explicitly instead
              // of burying it in a terminal reason string.
              const unresolvedReviews = config
                ? DagReviewLifecycle.unresolvedReviewOutcomes(config, nodes)
                : []
              return {
                title: `Workflow status: ${workflow.title}`,
                output: JSON.stringify(
                  {
                    id: workflow.id,
                    title: workflow.title,
                    status: workflow.status,
                    session_id: workflow.sessionId,
                    mode: config?.mode ?? "standard",
                    ...(unresolvedReviews.length > 0 ? { unresolved_reviews: unresolvedReviews } : {}),
                    ...(config?.admission
                      ? {
                          admission: {
                            verdict: config.admission.verdict,
                            state: config.admission.state,
                            qa_mode: config.admission.qa_mode,
                            brief_revision: config.admission.brief_revision,
                            fingerprint: config.admission.fingerprint,
                            ...(config.admission.waiver_reason
                              ? { waiver_reason: config.admission.waiver_reason }
                              : {}),
                            ...(config.admission.acknowledged_risks
                              ? { acknowledged_risks: config.admission.acknowledged_risks }
                              : {}),
                          },
                        }
                      : {}),
                    nodes: nodes.map((node) => ({
                      id: node.id,
                      name: node.name,
                      status: node.status,
                      required: node.required,
                      depends_on: node.dependsOn,
                      ...(node.childSessionId ? { child_session_id: node.childSessionId } : {}),
                      ...(node.errorReason ? { error_reason: node.errorReason } : {}),
                      ...(node.errorClass ? { error_class: node.errorClass } : {}),
                    })),
                  },
                  null,
                  2,
                ),
                metadata: { workflowId: workflow.id } as Metadata,
              }
            }
            case "result": {
              yield* requireOwnedWorkflow(params.workflow_id, ctx.sessionID)
              const node = yield* dag.store.getNode(params.workflow_id, params.node_id).pipe(Effect.orDie)
              if (!node) {
                return yield* Effect.die(new Error(`Workflow node not found: ${params.workflow_id}/${params.node_id}`))
              }
              // Train B (v1.0.15 B3): a submit-time file ref reads as a durable
              // pointer — content_ref + summary + path — and the parent agent
              // fetches the content itself (read tool). No paging: the pointer
              // is bounded by construction and next_cursor is never issued, so
              // inline outputs below keep the exact legacy paged read.
              if (isOutputFileRef(node.capturedOutput)) {
                return {
                  title: `Workflow result: ${node.name}`,
                  output: JSON.stringify(
                    {
                      workflow_id: params.workflow_id,
                      node_id: params.node_id,
                      status: node.status,
                      content_ref: node.capturedOutput.content_ref,
                      path: node.capturedOutput.path,
                      summary: node.capturedOutput.summary,
                      size: node.capturedOutput.size,
                      sha256: node.capturedOutput.sha256,
                      truncated: false,
                      next_cursor: null,
                    },
                    null,
                    2,
                  ),
                  metadata: {
                    workflowId: params.workflow_id,
                    nodeId: params.node_id,
                    truncated: false,
                  } as Metadata,
                }
              }
              const cursor = params.cursor
                ? decodeResultCursor(Buffer.from(params.cursor, "base64url").toString())
                : Option.some(
                    new ResultCursor({
                      version: 1 as const,
                      workflow_id: params.workflow_id,
                      node_id: params.node_id,
                      offset: 0,
                    }),
                  )
              if (
                Option.isNone(cursor) ||
                cursor.value.workflow_id !== params.workflow_id ||
                cursor.value.node_id !== params.node_id
              ) {
                return yield* Effect.die(new Error("Invalid or mismatched workflow result cursor"))
              }
              const durableResult = node.output ?? node.errorReason
              const content =
                typeof durableResult === "string"
                  ? durableResult
                  : durableResult == null
                    ? ""
                    : JSON.stringify(durableResult, null, 2)
              if (cursor.value.offset > content.length) {
                return yield* Effect.die(new Error("Workflow result cursor is beyond the current output"))
              }
              const pageEnd = resultPageEnd(content, cursor.value.offset, params.limit ?? DEFAULT_RESULT_PAGE_CHARS)
              const truncated = pageEnd < content.length
              const nextCursor = truncated
                ? ResultCursorToken.make(
                    Buffer.from(
                      JSON.stringify(
                        new ResultCursor({
                          version: 1,
                          workflow_id: params.workflow_id,
                          node_id: params.node_id,
                          offset: pageEnd,
                        }),
                      ),
                    ).toString("base64url"),
                  )
                : null
              return {
                title: `Workflow result: ${node.name}`,
                output: JSON.stringify(
                  {
                    workflow_id: params.workflow_id,
                    node_id: params.node_id,
                    status: node.status,
                    content: content.slice(cursor.value.offset, pageEnd),
                    truncated,
                    next_cursor: nextCursor,
                  },
                  null,
                  2,
                ),
                metadata: {
                  workflowId: params.workflow_id,
                  nodeId: params.node_id,
                  truncated,
                  ...(nextCursor ? { nextCursor } : {}),
                } as Metadata,
              }
            }
            case "start": {
              const sessionID = SessionID.make(ctx.sessionID)
              const source = yield* loadAuthoringSource(params.spec_path, callingSession.directory, ctx).pipe(
                Effect.orDie,
              )
              const result = yield* authoring.prepare({
                action: "start",
                source,
                profile: "environment",
                environment: { directory: callingSession.directory, parent: callingSession.model },
              })
              const blocking = result.errors.filter(
                (diagnostic) => diagnostic.code !== DagValidation.DIAGNOSTIC_CODES.modelUnavailable,
              )
              if (blocking.length > 0) return yield* rejectDiagnostics(blocking, "Workflow start")
              const missingModels = result.errors
                .filter((diagnostic) => diagnostic.code === DagValidation.DIAGNOSTIC_CODES.modelUnavailable)
                .map((diagnostic) => /^nodes\[([^\]]+)\]$/.exec(diagnostic.path)?.[1])
                .filter((node): node is string => node !== undefined)
              if (missingModels.length > 0) {
                yield* question
                  .ask({
                    sessionID,
                    questions: [
                      {
                        header: "DAG model",
                        question: `No model is available for DAG node${missingModels.length > 1 ? "s" : ""} ${missingModels.map((node) => `"${node}"`).join(", ")}. Configure the advanced/standard tiers in dag.jsonc, a model on the selected worker agent, or a parent-session model before starting. How would you like to proceed?`,
                        custom: false,
                        options: [
                          {
                            label: "Configure first",
                            description: "Do not start the workflow; configure a model and retry.",
                          },
                          {
                            label: "Cancel workflow",
                            description: "Abandon this workflow start.",
                          },
                        ],
                      },
                    ],
                    tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
                  })
                  .pipe(Effect.orDie)
                return {
                  title: "Workflow not started: model required",
                  output: `No workflow was created. Missing model for: ${missingModels.join(", ")}. Configure dag.jsonc, the worker agent, or the parent session, then retry.`,
                  metadata: {},
                }
              }
              if (result.prepared?.action !== "start") return yield* rejectDiagnostics(result.errors, "Workflow start")
              const prepared = result.prepared
              const dagID = yield* dag
                .create({
                  projectID: callingSession.projectID,
                  sessionID,
                  title: prepared.title,
                  config: {
                    ...prepared.config,
                    ...(prepared.admission ? { admission: createAdmissionRecord(prepared.admission) } : {}),
                  },
                })
                .pipe(Effect.orDie)
              const mode = prepared.config.mode ?? "standard"
              return {
                title: `Workflow started: ${prepared.config.name}`,
                output: `<workflow id="${dagID}" state="running" mode="${mode}">\n${result.prepared.nodes.length} nodes registered.\nDo not poll this workflow. It runs asynchronously and will wake the parent session when attention is required.\n</workflow>`,
                metadata: { workflowId: dagID } as Metadata,
              }
            }
            case "extend": {
              const workflow = yield* requireOwnedWorkflow(params.workflow_id, ctx.sessionID)
              const workflowDefaults = Dag.parseWorkflowConfig(workflow.config)?.node_defaults
              const knownDependencies = (yield* dag.store.getNodes(params.workflow_id).pipe(Effect.orDie)).map(
                (node) => node.id,
              )
              const source = yield* loadAuthoringSource(params.spec_path, callingSession.directory, ctx).pipe(
                Effect.orDie,
              )
              const result = yield* authoring.prepare({
                action: "extend",
                source,
                profile: "environment",
                environment: { directory: callingSession.directory, parent: callingSession.model },
                known_dependencies: knownDependencies,
                node_defaults: workflowDefaults,
              })
              if (!result.valid || !result.prepared) return yield* rejectDiagnostics(result.errors, "Workflow extend")
              const r = yield* withTerminalRecovery(
                dag.extend(params.workflow_id, result.prepared.nodes),
                "Terminal workflows are immutable except for the additive-extend reopen, which requires the workflow to have completed naturally at a wake-eligible reporting checkpoint (fragment adds new node ids; no early control(complete); no executed node beyond the checkpoint — condition-skipped dependents are fine). When the reopen does not apply, recover by starting a NEW workflow spec that reuses this workflow's completed outputs as static input.",
              ).pipe(Effect.orDie)
              return {
                title: `Workflow extended: ${r.add.length} nodes added`,
                output: `<workflow id="${params.workflow_id}" action="extend">\nAdded: ${r.add.join(", ")}\n</workflow>`,
                metadata: { workflowId: params.workflow_id, added: r.add } as Metadata,
              }
            }
            case "control": {
              const wfId = params.workflow_id
              const workflow = yield* requireOwnedWorkflow(wfId, ctx.sessionID)
              if (params.operation === "replan") {
                const workflowDefaults = Dag.parseWorkflowConfig(workflow.config)?.node_defaults
                const knownDependencies = (yield* dag.store.getNodes(wfId).pipe(Effect.orDie)).map((node) => node.id)
                const source = yield* loadAuthoringSource(params.spec_path, callingSession.directory, ctx).pipe(
                  Effect.orDie,
                )
                const result = yield* authoring.prepare({
                  action: "replan",
                  source,
                  profile: "environment",
                  environment: { directory: callingSession.directory, parent: callingSession.model },
                  known_dependencies: knownDependencies,
                  node_defaults: workflowDefaults,
                })
                if (!result.valid || !result.prepared) return yield* rejectDiagnostics(result.errors, "Workflow replan")
                // The graph raced to terminal while the fragment was being
                // composed (the pause-first protocol was skipped). Surface
                // the recovery options instead of a bare iron-law rejection.
                const r = yield* withTerminalRecovery(
                  dag.replan(wfId, { nodes: result.prepared.nodes }),
                  "The workflow reached a terminal status before the replan arrived — terminal workflows are immutable. Recover by starting a new workflow with the updated node definitions, or extend if a reporting leaf checkpoint naturally completed the graph. Next time issue control(pause) BEFORE composing the spec.",
                ).pipe(Effect.orDie)
                // A paused workflow (explicit pause-first protocol, or the
                // runtime's gate pause after a checkpoint replan verdict) must
                // resume for the corrective nodes to run — the replan intent
                // is "the graph changed, proceed", so resume closes the loop.
                // Resume races with concurrent control ops are tolerated: the
                // replan already landed, so never die on them.
                const wfAfterReplan = yield* dag.store.getWorkflow(wfId).pipe(Effect.orDie)
                const resumedFromPause = wfAfterReplan?.status === "paused"
                const resumedOk = resumedFromPause
                  ? yield* dag.resume(wfId).pipe(
                      Effect.map(() => true),
                      Effect.catch((error) =>
                        Effect.gen(function* () {
                          yield* Effect.logWarning("Workflow resume after replan failed", { wfId, error })
                          return false
                        }),
                      ),
                    )
                  : false
                const ignored =
                  r.ignore.length > 0
                    ? `\nIgnored (terminal, immutable — add replacements under new ids to retry): ${r.ignore.join(", ")}`
                    : ""
                const pauseNote = !resumedFromPause
                  ? ""
                  : resumedOk
                    ? "\nWorkflow was paused and has been resumed — corrective nodes are now schedulable."
                    : "\nWorkflow was paused; automatic resume raced with another control op — check status and issue control(resume) if still paused."
                return {
                  title: `Workflow replanned: +${r.add.length} -${r.cancel.length} ↻${r.restart.length}`,
                  output: `<workflow id="${wfId}" action="replan">\nAdded: ${r.add.join(", ")}\nCancelled: ${r.cancel.join(", ")}\nRestarted: ${r.restart.join(", ")}\nReplaced: ${r.replace.join(", ")}${ignored}${pauseNote}\n</workflow>`,
                  metadata: { workflowId: wfId, ...r } as Metadata,
                }
              }
              switch (params.operation) {
                case "pause":
                  yield* dag.pause(wfId).pipe(Effect.orDie)
                  return {
                    title: "Workflow paused",
                    output: `<workflow id="${wfId}" state="paused"/>\nNote: pause stops new node spawns only — nodes already running continue to completion. To stop a running node, submit a replan spec marking it restart: true or cancel: true (replan is valid while paused, and a successful replan resumes the paused workflow so corrective nodes can run).`,
                    metadata: { workflowId: wfId } as Metadata,
                  }
                case "resume":
                  yield* dag.resume(wfId).pipe(Effect.orDie)
                  return {
                    title: "Workflow resumed",
                    output: `<workflow id="${wfId}" state="running"/>`,
                    metadata: { workflowId: wfId } as Metadata,
                  }
                case "cancel":
                  yield* dag.cancel(wfId).pipe(Effect.orDie)
                  return {
                    title: "Workflow cancelled",
                    output: `<workflow id="${wfId}" state="cancelled"/>`,
                    metadata: { workflowId: wfId } as Metadata,
                  }
                case "complete":
                  yield* dag.complete(wfId).pipe(Effect.orDie)
                  return {
                    title: "Workflow completed (early)",
                    output: `<workflow id="${wfId}" state="completed"/>`,
                    metadata: { workflowId: wfId } as Metadata,
                  }
                case "step": {
                  const r = yield* dag.step(wfId).pipe(Effect.orDie)
                  if (r.status === "no_ready_nodes") {
                    return {
                      title: "Workflow step: no ready nodes",
                      output: `<workflow id="${wfId}" state="running" action="step" result="no_ready_nodes"/>`,
                      metadata: { workflowId: wfId } as Metadata,
                    }
                  }
                  return {
                    title: `Workflow stepped: ${r.nodeID ?? "no node"}`,
                    output: `<workflow id="${wfId}" state="stepping" action="step" node="${r.nodeID ?? ""}"/>`,
                    metadata: { workflowId: wfId, ...r } as Metadata,
                  }
                }
              }
            }
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

// ============================================================================
// Helpers
// ============================================================================

function resultPageEnd(content: string, offset: number, limit: number) {
  const end = Math.min(content.length, offset + limit)
  if (end >= content.length) return end
  const splitsSurrogatePair =
    content.charCodeAt(end - 1) >= 0xd800 &&
    content.charCodeAt(end - 1) <= 0xdbff &&
    content.charCodeAt(end) >= 0xdc00 &&
    content.charCodeAt(end) <= 0xdfff
  if (!splitsSurrogatePair) return end
  return end - offset === 1 ? end + 1 : end - 1
}

function validationOutput(result: DagValidation.ValidationResult) {
  return {
    source: result.source,
    profile: result.profile,
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    nodes: result.nodes,
  }
}

const DRAFT_DIRECTORY = path.join(".opencode", "workflow-drafts")
const DRAFT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/

function writeDraftSpec(
  config: DagValidation.StartGraph,
  title: string | undefined,
  directory: string,
): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    if (!DRAFT_NAME_PATTERN.test(config.name)) {
      return yield* Effect.fail(
        new Error(
          `Workflow name must match ${DRAFT_NAME_PATTERN.source} (it becomes the spec filename): ${config.name}`,
        ),
      )
    }
    const dir = path.join(directory, DRAFT_DIRECTORY)
    yield* Effect.promise(() => Bun.write(Bun.file(path.join(dir, ".keep")), ""))
    const specPath = path.join(dir, `${config.name}.yaml`)
    const content = yamlStringify({ ...(title ? { title } : {}), config })
    yield* Effect.promise(() => Bun.write(specPath, content))
    return specPath
  })
}

function readDraftSpec(specPath: string) {
  return Effect.tryPromise({
    try: () => Bun.file(specPath).text(),
    catch: (error) => new Error(`Failed to read draft spec ${specPath}: ${String(error)}`),
  })
}

function loadSpecFile(specPath: string, directory: string, ctx: Tool.Context) {
  return Effect.gen(function* () {
    const filepath = yield* resolveSpecPath(specPath, directory, ctx)

    // Builtin templates are compiled into the binary (no backing file).
    if (DagWorkflows.isBuiltinPath(filepath)) {
      const content = DagWorkflows.builtinTemplates()[DagWorkflows.builtinName(filepath)]
      if (content === undefined) {
        return yield* Effect.fail(new Error(`Workflow spec not found: ${filepath}`))
      }
      return { path: filepath, content }
    }

    const file = Bun.file(filepath)
    if (!(yield* Effect.promise(() => file.exists()))) {
      return yield* Effect.fail(new Error(`Workflow spec not found: ${filepath}`))
    }
    if (file.size > MAX_WORKFLOW_SPEC_BYTES) {
      return yield* Effect.fail(
        new Error(`Workflow spec is too large: ${file.size} bytes exceeds ${MAX_WORKFLOW_SPEC_BYTES}`),
      )
    }
    const content = yield* Effect.tryPromise({
      try: () => file.text(),
      catch: (error) => new Error(`Failed to read workflow spec ${filepath}: ${String(error)}`),
    })
    return { path: filepath, content }
  })
}

function loadAuthoringSource(
  specPath: string,
  directory: string,
  ctx: Tool.Context,
): Effect.Effect<AuthoringSource, Error> {
  return loadSpecFile(specPath, directory, ctx).pipe(
    Effect.map((file) => ({ kind: "yaml" as const, source: file.path, content: file.content })),
  )
}

/** Directories (and the builtin fallback, when the release ships templates) a
 * bare workflow name may resolve from — for "not found" / empty-library hints. */
function searchedScopes(directory: string) {
  const scopes = DagWorkflows.searchPaths(directory)
  if (Object.keys(DagWorkflows.builtinTemplates()).length > 0) scopes.push("the release's builtin templates")
  return scopes.join(" and ")
}

function resolveSpecPath(specPath: string, directory: string, ctx: Tool.Context) {
  return Effect.gen(function* () {
    // A bare name addresses the workflow library. Its project/global scopes
    // are curated assets the user placed under `.opencode/` or the config
    // dir — the same trust level as dag.jsonc — so a resolved name needs no
    // external-directory prompt even when the global scope lands outside the
    // session directory. Arbitrary paths below keep the prompt.
    if (DagWorkflows.isName(specPath)) {
      const entry = yield* DagWorkflows.resolve(specPath, directory)
      if (entry) return entry.path
      return yield* Effect.fail(
        new Error(
          `Saved workflow not found: "${specPath}". Searched ${searchedScopes(directory)}. Run workflow(action: "list") to see what is available, or pass a path to a .yaml spec file.`,
        ),
      )
    }
    const filepath = path.isAbsolute(specPath) ? path.normalize(specPath) : path.resolve(directory, specPath)
    if (![".yaml", ".yml"].includes(path.extname(filepath).toLowerCase())) {
      return yield* Effect.fail(new Error(`Workflow spec must be a .yaml or .yml file: ${filepath}`))
    }
    if (!FSUtil.contains(directory, filepath)) {
      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
      })
    }
    return filepath
  })
}

/** Terminal-workflow rejections surface as defects carrying recovery
 * guidance, not bare iron-law errors. Shared by the replan and extend paths. */
function withTerminalRecovery<A>(effect: Effect.Effect<A, Error>, guidance: string) {
  return effect.pipe(
    Effect.catchIf(
      (err): err is TerminalViolationError => err instanceof TerminalViolationError,
      (err) => Effect.die(new Error(`${err.message}. ${guidance}`)),
    ),
  )
}

async function entryContent(entry: DagWorkflows.Entry): Promise<string | undefined> {
  if (entry.content !== undefined) return entry.content
  return Bun.file(entry.path)
    .text()
    .catch(() => undefined)
}
