import * as Tool from "./tool"
import { CommandPlugin } from "@opencode-ai/core/plugin/command"
import { Effect, Schema } from "effect"
import { Dag } from "@/dag/dag"
import { DagConfig } from "@/dag/config"
import { DagWorkflows } from "@/dag/workflows"
import { DagModel } from "@/dag/model"
import { DagBlocks } from "@/dag/blocks"
import { Agent } from "@/agent/agent"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import { AdmissionInput, createAdmissionRecord, ExecutionMode } from "@/dag/admission"
import { TerminalViolationError } from "@opencode-ai/core/dag/core/types"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { assertExternalDirectoryEffect } from "./external-directory"
import path from "node:path"

const id = "workflow"
const MAX_WORKFLOW_SPEC_BYTES = 1_000_000

// ============================================================================
// Action schemas remain the single validation authority for file and inline input.
// ============================================================================

const NodeSchema = Schema.Struct({
  id: Schema.String.annotate({ description: "Unique node identifier, used in depends_on" }),
  name: Schema.String.annotate({ description: "Human-readable node name" }),
  worker_type: Schema.String.annotate({ description: "Agent type (explore, build, general, plan, or custom)" }),
  depends_on: Schema.Array(Schema.String).annotate({ description: "Node IDs this node waits for ([] for root)" }),
  required: Schema.optional(Schema.Boolean).annotate({
    description:
      "If true and this node fails, the workflow terminalizes as failed. Inherits config.node_defaults.required",
  }),
  prompt_template: Schema.Struct({
    id: Schema.optional(Schema.String),
    inline: Schema.optional(Schema.String),
    input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }).annotate({
    description:
      'Template: { id: "..." } or { inline: "...", input: {...} }. Direct dependency outputs are available as {{node-id}} by default',
  }),
  worker_config: Schema.optional(
    Schema.Struct({
      timeout_ms: Schema.optional(Schema.Number),
    }),
  ).annotate({ description: "{ timeout_ms } — bounds node execution. Inherits config.node_defaults.worker_config" }),
  input_mapping: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description:
      'Optional variable-to-source map, e.g. { resultA: "node-a", count: "node-b.output.count" }. Omit to expose each direct dependency under its node ID',
  }),
  report_to_parent: Schema.optional(Schema.Boolean).annotate({
    description:
      "If true, the parent agent is woken when this node completes or fails. Inherits config.node_defaults.report_to_parent",
  }),
  condition: Schema.optional(Schema.String).annotate({
    description: "Expression evaluated before spawn; node is skipped if false",
  }),
  restart: Schema.optional(Schema.Boolean).annotate({
    description:
      "(replan only) Re-spawn this running node with new prompt. Running nodes only — terminal (completed/failed/skipped) nodes are immutable; to retry a failed node, add a replacement node under a new id",
  }),
  cancel: Schema.optional(Schema.Boolean).annotate({ description: "(replan only) Cancel this node" }),
  output_schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "JSON Schema; child agent must call submit_result to submit structured output",
  }),
  review: Schema.optional(
    Schema.Struct({
      phase: Schema.Literals(["design", "diff"]),
      implementation_node_id: Schema.optional(Schema.String),
      verification_node_id: Schema.optional(Schema.String),
    }),
  ).annotate({
    description:
      "(deep review workers) design reviews pre-implementation artifacts; diff reviews require implementation_node_id and verification_node_id",
  }),
})

const WorkflowGraphSchema = Schema.Struct({
  name: Schema.String.annotate({ description: "Workflow name" }),
  node_defaults: Schema.optional(
    Schema.Struct({
      required: Schema.optional(Schema.Boolean),
      worker_config: Schema.optional(
        Schema.Struct({
          timeout_ms: Schema.optional(Schema.Number),
        }),
      ),
      report_to_parent: Schema.optional(Schema.Boolean),
    }),
  ).annotate({
    description: "Defaults inherited by nodes that omit required, worker_config, or report_to_parent",
  }),
  max_concurrency: Schema.optional(Schema.Number).annotate({ description: "Max parallel nodes. Default: 5" }),
  max_node_replan_attempts: Schema.optional(Schema.Number).annotate({
    description: "Max replan restarts per node ID. Default: 5",
  }),
  max_total_nodes: Schema.optional(Schema.Number).annotate({
    description: "Cumulative node cap across the workflow lifetime. Default: 100",
  }),
  objective: Schema.optional(Schema.String).annotate({
    description: "Required when using blocks; injected into every generated child prompt",
  }),
  blocks: Schema.optional(Schema.Array(DagBlocks.WorkflowBlock)).annotate({
    description: "High-level graph compiled into nodes. Use blocks or nodes, never both",
  }),
  nodes: Schema.optional(Schema.Array(NodeSchema)).annotate({
    description: "Low-level node declarations. Use nodes or blocks, never both",
  }),
})

// Exported so the committed workflow library can be validated in tests.
export const StartSpec = Schema.Struct({
  title: Schema.optional(Schema.String),
  mode: Schema.optional(ExecutionMode),
  admission: Schema.optional(AdmissionInput),
  config: WorkflowGraphSchema,
})

const ExtendSpec = Schema.Struct({
  objective: Schema.optional(Schema.String),
  blocks: Schema.optional(Schema.Array(DagBlocks.WorkflowBlock)),
  nodes: Schema.optional(Schema.Array(NodeSchema)),
})

const ReplanSpec = Schema.Struct({
  fragment: WorkflowGraphSchema,
})

const decodeStartSpec = Schema.decodeUnknownEffect(StartSpec)
const decodeExtendSpec = Schema.decodeUnknownEffect(ExtendSpec)
const decodeReplanSpec = Schema.decodeUnknownEffect(ReplanSpec)

export const Parameters = Schema.Struct({
  action: Schema.Literals(["start", "extend", "control", "status", "list", "read", "guide"]).annotate({
    description:
      "start: create workflow; extend: add nodes or blocks; control: pause/resume/cancel/replan/step/complete; status: inspect durable state; list: show saved specs; read: inspect one saved spec before retargeting it; guide: load detailed guidance only when needed",
  }),
  topic: Schema.optional(Schema.Literals(["blocks", "interface", "policy", "patterns"])).annotate({
    description:
      "(guide) blocks: composable block schema; interface: low-level workflow API; policy: gates/admission/recovery; patterns: domain playbooks. Omit for the compact index",
  }),
  spec: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description:
      "(start/extend/control replan) Inline structured spec for a one-off graph. Use this or spec_path, never both",
  }),
  spec_path: Schema.optional(Schema.String).annotate({
    description:
      '(start/extend/control replan/read) A saved workflow name from the library (e.g. "code-review"), or a path to a YAML workflow spec. Relative paths resolve from the session directory',
  }),
  session_id: Schema.optional(Schema.String).annotate({
    description: "(start) Parent session ID; when provided, it must match the calling session",
  }),
  project_id: Schema.optional(Schema.String).annotate({
    description: "(start) Optional Project ID; must match the parent session project",
  }),
  workflow_id: Schema.optional(Schema.String).annotate({ description: "(extend/control/status) Target workflow ID" }),
  operation: Schema.optional(Schema.Literals(["pause", "resume", "cancel", "replan", "step", "complete"])).annotate({
    description: "(control) Operation to perform",
  }),
})

// ============================================================================
// Tool definition
// ============================================================================

type Metadata = { workflowId?: string; added?: string[]; cancel?: string[]; restart?: string[]; replace?: string[] }

export const WorkflowTool = Tool.define<
  typeof Parameters,
  Metadata,
  Dag.Service | Session.Service | Agent.Service | Question.Service
>(
  id,
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const question = yield* Question.Service

    const requireOwnedWorkflow = Effect.fn("WorkflowTool.requireOwnedWorkflow")(function* (
      workflowID: string,
      sessionID: string,
    ) {
      const workflow = yield* dag.store.getWorkflow(workflowID).pipe(Effect.orDie)
      if (!workflow || workflow.sessionId !== sessionID) {
        return yield* Effect.die(new Error(`Workflow not found: ${workflowID}`))
      }
      return workflow
    })

    return {
      description: CommandPlugin.WorkflowContent,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const callingSession = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
          if (callingSession.parentID) {
            return yield* Effect.die(
              new Error("Workflow orchestration is available only to the main conversation, not child agents"),
            )
          }
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
                    "- patterns: larger review, engineering, diagnosis, and audit topologies",
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
            case "list": {
              const session = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
              const entries = yield* DagWorkflows.list(session.directory)
              if (entries.length === 0) {
                return {
                  title: "No saved workflows",
                  output: `The workflow library is empty. Searched ${searchedScopes(session.directory)}. Save a spec as <name>.yaml in one of those directories to start it later by name.`,
                  metadata: {},
                }
              }
              return {
                title: `${entries.length} saved workflow${entries.length > 1 ? "s" : ""}`,
                output: entries
                  .map((entry) =>
                    [
                      `${entry.name} [${entry.scope}]`,
                      entry.title ? ` — ${entry.title}` : "",
                      entry.nodes !== undefined
                        ? ` (${entry.nodes} nodes)`
                        : entry.blocks !== undefined
                          ? ` (${entry.blocks} blocks)`
                          : "",
                      `\n  ${entry.path}`,
                    ].join(""),
                  )
                  .join("\n"),
                metadata: {},
              }
            }
            case "read": {
              if (!params.spec_path || params.spec) {
                return yield* Effect.die(
                  new Error("read requires exactly one 'spec_path' and does not accept inline 'spec'"),
                )
              }
              const session = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
              const specFile = yield* readWorkflowSpec(undefined, params.spec_path, session.directory, ctx).pipe(
                Effect.orDie,
              )
              return {
                title: `Workflow spec: ${params.spec_path}`,
                output: JSON.stringify(specFile.value, null, 2),
                metadata: {},
              }
            }
            case "status": {
              if (!params.workflow_id) return yield* Effect.die(new Error("status requires 'workflow_id'"))
              const workflow = yield* requireOwnedWorkflow(params.workflow_id, ctx.sessionID)
              const nodes = yield* dag.store.getNodes(params.workflow_id).pipe(Effect.orDie)
              const config = Dag.parseWorkflowConfig(workflow.config)
              return {
                title: `Workflow status: ${workflow.title}`,
                output: JSON.stringify(
                  {
                    id: workflow.id,
                    title: workflow.title,
                    status: workflow.status,
                    session_id: workflow.sessionId,
                    mode: config?.mode ?? "standard",
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
            case "start": {
              if (params.session_id && params.session_id !== ctx.sessionID) {
                return yield* Effect.die(new Error("session_id must match the calling session"))
              }
              const sessionID = SessionID.make(ctx.sessionID)
              const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
              if (params.project_id && params.project_id !== session.projectID) {
                return yield* Effect.die(new Error("project_id must match the parent session project"))
              }
              const specFile = yield* readWorkflowSpec(params.spec, params.spec_path, session.directory, ctx).pipe(
                Effect.orDie,
              )
              const spec = yield* decodeStartSpec(specFile.value).pipe(
                Effect.mapError((error) => new Error(`Invalid workflow spec ${specFile.path}: ${String(error)}`)),
                Effect.orDie,
              )
              const config = compileGraph(spec.config, specFile.path)
              const missingModels = yield* findNodesWithoutModel({
                nodes: config.nodes,
                defaults: config.node_defaults,
                directory: session.directory,
                parent: session.model,
                agents,
              })
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
              const dagID = yield* dag
                .create({
                  projectID: session.projectID,
                  sessionID,
                  title: spec.title ?? config.name,
                  config: {
                    ...config,
                    mode: spec.mode ?? "standard",
                    ...(spec.admission ? { admission: createAdmissionRecord(spec.admission) } : {}),
                  } as WorkflowConfig,
                })
                .pipe(Effect.orDie)
              const mode = spec.mode ?? "standard"
              return {
                title: `Workflow started: ${config.name}`,
                output: `<workflow id="${dagID}" state="running" mode="${mode}">\n${config.nodes.length} nodes registered.\nDo not poll this workflow. It runs asynchronously and will wake the parent session when attention is required.\n</workflow>`,
                metadata: { workflowId: dagID } as Metadata,
              }
            }
            case "extend": {
              if (!params.workflow_id) return yield* Effect.die(new Error("extend requires 'workflow_id'"))
              yield* requireOwnedWorkflow(params.workflow_id, ctx.sessionID)
              const session = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
              const specFile = yield* readWorkflowSpec(params.spec, params.spec_path, session.directory, ctx).pipe(
                Effect.orDie,
              )
              const spec = yield* decodeExtendSpec(specFile.value).pipe(
                Effect.mapError((error) => new Error(`Invalid workflow spec ${specFile.path}: ${String(error)}`)),
                Effect.orDie,
              )
              const knownDependencies = (yield* dag.store.getNodes(params.workflow_id).pipe(Effect.orDie)).map(
                (node) => node.id,
              )
              const nodes = compileNodeSource(spec, specFile.path, knownDependencies)
              const r = yield* withTerminalRecovery(
                dag.extend(params.workflow_id, nodes),
                "Terminal workflows are immutable except for the additive-extend reopen, which requires the workflow to have completed naturally at a wake-eligible reporting checkpoint (fragment adds new node ids; no early control(complete); no executed node beyond the checkpoint — condition-skipped dependents are fine). When the reopen does not apply, recover by starting a NEW workflow spec that reuses this workflow's completed outputs as static input.",
              ).pipe(Effect.orDie)
              return {
                title: `Workflow extended: ${r.add.length} nodes added`,
                output: `<workflow id="${params.workflow_id}" action="extend">\nAdded: ${r.add.join(", ")}\n</workflow>`,
                metadata: { workflowId: params.workflow_id, added: r.add } as Metadata,
              }
            }
            case "control": {
              if (!params.workflow_id || !params.operation) {
                return yield* Effect.die(
                  new Error(
                    `control requires 'workflow_id' and 'operation' (got workflow_id=${params.workflow_id ?? "<missing>"}, operation=${params.operation ?? "<missing>"}). Example: { action: "control", workflow_id: "dag_...", operation: "pause" }. On a cancel/replan intent, issue pause FIRST — it needs no spec and freezes scheduling instantly while you compose the replan.`,
                  ),
                )
              }
              const wfId = params.workflow_id
              yield* requireOwnedWorkflow(wfId, ctx.sessionID)
              switch (params.operation) {
                case "pause":
                  yield* dag.pause(wfId).pipe(Effect.orDie)
                  return {
                    title: "Workflow paused",
                    output: `<workflow id="${wfId}" state="paused"/>\nNote: pause stops new node spawns only — nodes already running continue to completion. To stop a running node, submit a replan spec marking it restart: true or cancel: true (replan is valid while paused).`,
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
                case "replan": {
                  const session = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
                  const specFile = yield* readWorkflowSpec(params.spec, params.spec_path, session.directory, ctx).pipe(
                    Effect.orDie,
                  )
                  const spec = yield* decodeReplanSpec(specFile.value).pipe(
                    Effect.mapError((error) => new Error(`Invalid workflow spec ${specFile.path}: ${String(error)}`)),
                    Effect.orDie,
                  )
                  const knownDependencies = (yield* dag.store.getNodes(wfId).pipe(Effect.orDie)).map((node) => node.id)
                  const fragment = compileGraph(spec.fragment, specFile.path, knownDependencies)
                  // The graph raced to terminal while the fragment was being
                  // composed (the pause-first protocol was skipped). Surface
                  // the recovery options instead of a bare iron-law rejection.
                  const r = yield* withTerminalRecovery(
                    dag.replan(wfId, { nodes: fragment.nodes }),
                    "The workflow reached a terminal status before the replan arrived — terminal workflows are immutable. Recover by starting a new workflow with the updated node definitions, or extend if a reporting leaf checkpoint naturally completed the graph. Next time issue control(pause) BEFORE composing the spec.",
                  ).pipe(Effect.orDie)
                  const ignored =
                    r.ignore.length > 0
                      ? `\nIgnored (terminal, immutable — add replacements under new ids to retry): ${r.ignore.join(", ")}`
                      : ""
                  return {
                    title: `Workflow replanned: +${r.add.length} -${r.cancel.length} ↻${r.restart.length}`,
                    output: `<workflow id="${wfId}" action="replan">\nAdded: ${r.add.join(", ")}\nCancelled: ${r.cancel.join(", ")}\nRestarted: ${r.restart.join(", ")}\nReplaced: ${r.replace.join(", ")}${ignored}\n</workflow>`,
                    metadata: { workflowId: wfId, ...r } as Metadata,
                  }
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

type WorkflowGraphInput = Schema.Schema.Type<typeof WorkflowGraphSchema>
type NodeSource = Pick<WorkflowGraphInput, "objective" | "blocks" | "nodes">

function compileGraph(graph: WorkflowGraphInput, source: string, knownDependencies?: string[]) {
  const nodes = compileNodeSource(graph, source, knownDependencies)
  const { objective: _objective, blocks: _blocks, nodes: _nodes, ...config } = graph
  return {
    ...config,
    nodes,
  } as WorkflowConfig
}

function compileNodeSource(source: NodeSource, path: string, knownDependencies?: string[]) {
  const hasNodes = source.nodes !== undefined
  const hasBlocks = source.blocks !== undefined
  if (hasNodes === hasBlocks) throw new Error(`Invalid workflow graph ${path}: use exactly one of nodes or blocks`)
  if (source.nodes) return source.nodes as NodeConfig[]
  if (!source.objective) throw new Error(`Invalid workflow graph ${path}: blocks require objective`)
  return DagBlocks.compileWorkflowBlocks(
    {
      objective: source.objective,
      blocks: source.blocks as DagBlocks.WorkflowBlock[],
    },
    { known_dependencies: knownDependencies },
  )
}

function readWorkflowSpec(
  spec: Record<string, unknown> | undefined,
  specPath: string | undefined,
  directory: string,
  ctx: Tool.Context,
) {
  return Effect.gen(function* () {
    if (spec && specPath) {
      return yield* Effect.fail(
        new Error("Workflow configuration accepts exactly one source: remove either 'spec' or 'spec_path'."),
      )
    }
    if (spec) return { path: "<inline>", value: spec }
    if (!specPath) {
      return yield* Effect.fail(
        new Error(
          `Workflow configuration requires exactly one of 'spec' or 'spec_path'. Pass an inline structured spec for a one-off graph, or a saved workflow name/path through 'spec_path'.`,
        ),
      )
    }
    const filepath = yield* resolveSpecPath(specPath, directory, ctx)

    // Builtin templates are compiled into the binary (no backing file).
    if (DagWorkflows.isBuiltinPath(filepath)) {
      const content = DagWorkflows.builtinTemplates()[DagWorkflows.builtinName(filepath)]
      if (content === undefined) {
        return yield* Effect.fail(new Error(`Workflow spec not found: ${filepath}`))
      }
      const value = yield* Effect.try({
        try: () => Bun.YAML.parse(content),
        catch: (error) => workflowSpecParseError(filepath, error),
      })
      return { path: filepath, value }
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
    const value = yield* Effect.try({
      try: () => Bun.YAML.parse(content),
      catch: (error) => workflowSpecParseError(filepath, error),
    })
    return { path: filepath, value }
  })
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

function workflowSpecParseError(filepath: string, error: unknown) {
  return new Error(`Invalid workflow YAML ${filepath}: ${error instanceof Error ? error.message : String(error)}`)
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

function findNodesWithoutModel(input: {
  nodes: ReadonlyArray<Schema.Schema.Type<typeof NodeSchema>>
  defaults?: Schema.Schema.Type<typeof WorkflowGraphSchema>["node_defaults"]
  directory: string
  parent?: Session.Info["model"]
  agents: Agent.Interface
}) {
  if (input.nodes.length === 0) return Effect.succeed([])
  return Effect.gen(function* () {
    const config = yield* DagConfig.load(input.directory)
    return yield* Effect.filter(
      input.nodes,
      (node) =>
        Effect.gen(function* () {
          const agent = yield* input.agents.get(node.worker_type).pipe(
            Effect.map((info) => info as Agent.Info | undefined),
            Effect.catchCause(() => Effect.succeed(undefined)),
          )
          return (
            DagModel.resolve({
              tier: DagConfig.tierModel(config, {
                required: node.required ?? input.defaults?.required ?? Dag.DEFAULT_WORKFLOW_CONFIG.nodeRequired,
                workerType: node.worker_type,
              }),
              agent: agent?.model,
              parent: input.parent ? { modelID: input.parent.id, providerID: input.parent.providerID } : undefined,
            }) === undefined
          )
        }),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((nodes) => nodes.map((node) => node.id)))
  })
}
