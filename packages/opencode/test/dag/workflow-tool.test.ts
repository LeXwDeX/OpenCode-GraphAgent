import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Parameters, WorkflowTool } from "@/tool/workflow"
import { testEffect } from "../lib/effect"
import { fingerprintBrief, type State } from "@/dag/admission"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"

const projectID = ProjectV2.ID.make("project_test")
let workflowSpecDirectory = ""

beforeAll(async () => {
  workflowSpecDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-spec-"))
})

afterAll(async () => {
  await fs.rm(workflowSpecDirectory, { recursive: true, force: true })
})

const admissionBrief = {
  goal: "Qualify and execute a deep workflow",
  scope: {
    in: ["workflow start", "review lifecycle"],
    out: ["new admission UI"],
  },
  constraints: ["standard workflows stay compatible"],
  assumptions: ["the parent session can ask questions"],
  acceptance_criteria: ["deep start requires READY or WAIVED"],
  evidence_required: ["unit tests", "integration tests"],
  risks: ["waiver misuse"],
  review_plan: ["verify", "review the implementation diff"],
  open_questions: [],
  blocking_questions: [],
}

function admissionFor(
  verdict: "READY" | "NOT_READY" | "WAIVED",
  state: State = verdict,
) {
  const brief = verdict === "READY"
    ? admissionBrief
    : {
        ...admissionBrief,
        blocking_questions: ["Confirm the production rollout target"],
      }
  return {
    protocol_version: 1,
    brief_revision: 1,
    qa_mode: "STANDARD" as const,
    verdict,
    state,
    fingerprint: fingerprintBrief(brief),
    brief,
    ...(verdict === "WAIVED"
      ? {
          waiver_reason: "Preview release only",
          acknowledged_risks: ["Production rollout is unresolved"],
        }
      : {}),
  }
}

function admissionInputFor(verdict: "READY" | "NOT_READY" | "WAIVED") {
  const record = admissionFor(verdict)
  return {
    brief_revision: record.brief_revision,
    qa_mode: record.qa_mode,
    verdict: record.verdict,
    brief: record.brief,
    ...(record.waiver_reason ? { waiver_reason: record.waiver_reason } : {}),
    ...(record.acknowledged_risks ? { acknowledged_risks: record.acknowledged_risks } : {}),
  }
}

const published: Array<{ type: string; data: unknown }> = []
const store = Layer.mock(DagStore.Service, {
  getWorkflow: (id: string) =>
    Effect.succeed(
      id === "dag_status"
        ? {
            id,
            projectId: projectID,
            sessionId: "ses_workflow_parent",
            title: "Status workflow",
            status: "running",
            config: "{}",
            seq: 1,
            wakeReported: false,
            startedAt: 1,
            completedAt: null,
            timeCreated: 1,
            timeUpdated: 2,
          }
        : id === "dag_deep_status"
          ? {
              id,
              projectId: projectID,
              sessionId: "ses_workflow_parent",
              title: "Deep status workflow",
              status: "running",
              config: JSON.stringify({
                name: "deep-status",
                mode: "deep",
                admission: {
                  ...admissionFor("WAIVED"),
                  state: "CONSUMED",
                },
                nodes: [],
              }),
              seq: 1,
              wakeReported: false,
              startedAt: 1,
              completedAt: null,
              timeCreated: 1,
              timeUpdated: 2,
            }
        : id === "dag_defaults"
          ? {
              id,
              projectId: projectID,
              sessionId: "ses_workflow_parent",
              title: "Configured defaults",
              status: "running",
              config: JSON.stringify({
                name: "configured-defaults",
                node_defaults: {
                  required: true,
                  report_to_parent: true,
                  worker_config: { timeout_ms: 1234 },
                  model: {
                    providerID: "local-proxy-compatible",
                    modelID: "local-proxy-compatible/glm-5.2",
                  },
                },
                max_concurrency: 5,
                max_node_replan_attempts: 5,
                max_total_nodes: 100,
                nodes: [],
              }),
              seq: 1,
              wakeReported: false,
              startedAt: 1,
              completedAt: null,
              timeCreated: 1,
              timeUpdated: 2,
            }
        : undefined,
    ),
  getNodes: (id: string) =>
    Effect.succeed(
      id === "dag_status"
        ? [{
        id: "node_running",
        workflowId: "dag_status",
        name: "Running node",
        workerType: "build",
        status: "running",
        required: true,
        dependsOn: [],
        modelId: null,
        modelProviderId: null,
        childSessionId: "ses_child",
        output: null,
        capturedOutput: null,
        errorReason: null,
        deadlineMs: null,
        wakeEligible: true,
        wakeReported: false,
        replanAttempts: 0,
        seq: 1,
        startedAt: 1,
        completedAt: null,
        timeCreated: 1,
        timeUpdated: 2,
          }]
        : [],
    ),
})
const events = Layer.mock(EventV2Bridge.Service, {
  publish: (definition, data) =>
    Effect.sync(() => {
      published.push({ type: definition.type, data })
      return { id: "event_test", type: definition.type, data } as never
    }),
})
const dag = Dag.layer.pipe(
  Layer.provide(store),
  Layer.provide(events),
)
const runtime = testEffect(
  Layer.mergeAll(
    Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "build",
          mode: "all",
          permission: [],
          options: {},
          description: "",
          prompt: "",
          tools: {},
          hooks: {},
        }),
    }),
    Layer.mock(Truncate.Service, {
      output: (content) => Effect.succeed({ content, truncated: false }),
    }),
    Layer.mock(Question.Service, {
      ask: () => Effect.succeed([["Configure first"]]),
    }),
    dag,
    Layer.mock(Session.Service, {
      get: (id: Parameters<Session.Interface["get"]>[0]) =>
        Effect.succeed({
          id,
          slug: "workflow-test",
          projectID,
          directory: workflowSpecDirectory,
          title: "Workflow test",
          version: "test",
          time: { created: 0, updated: 0 },
          model: {
            providerID: ProviderV2.ID.make("test"),
            id: ModelV2.ID.make("test-model"),
          },
        } satisfies Session.Info),
    }),
  ),
)

let missingModelDirectory = ""
const questionsAsked: Question.Info[] = []
const missingModelRuntime = testEffect(
  Layer.mergeAll(
    Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "build",
          mode: "all",
          permission: [],
          options: {},
        }),
    }),
    Layer.mock(Truncate.Service, {
      output: (content) => Effect.succeed({ content, truncated: false }),
    }),
    Layer.mock(Question.Service, {
      ask: (input) =>
        Effect.sync(() => {
          questionsAsked.push(...input.questions)
          return [["Configure first"]]
        }),
    }),
    dag,
    Layer.mock(Session.Service, {
      get: (id: Parameters<Session.Interface["get"]>[0]) =>
        Effect.succeed({
          id,
          slug: "workflow-test",
          projectID,
          directory: missingModelDirectory,
          title: "Workflow test",
          version: "test",
          time: { created: 0, updated: 0 },
        } satisfies Session.Info),
    }),
  ),
)

function writeWorkflowSpec(name: string, value: unknown) {
  const filepath = path.join(workflowSpecDirectory, `${name}.yaml`)
  return Effect.promise(() => Bun.write(filepath, JSON.stringify(value, null, 2))).pipe(
    Effect.as(filepath),
  )
}

describe("workflow tool schema (negative tests)", () => {
  it("action field accepts start/extend/control/status", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "start", spec_path: ".opencode/workflows/test.yaml" })).not.toThrow()
    expect(() => decode({ action: "extend", workflow_id: "wf-1", spec_path: ".opencode/workflows/extend.yaml" })).not.toThrow()
    expect(() => decode({ action: "control", workflow_id: "wf-1", operation: "pause" })).not.toThrow()
    expect(() => decode({ action: "status", workflow_id: "wf-1" })).not.toThrow()
  })

  it("action field rejects unknown actions", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "delete" })).toThrow()
  })

  it("no node_complete action exists", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "node_complete" })).toThrow()
  })

  it("no unsupported read-only actions exist (list/history/logs)", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "list" })).toThrow()
    expect(() => decode({ action: "history" })).toThrow()
    expect(() => decode({ action: "logs" })).toThrow()
  })

  it("control operation accepts pause/resume/cancel/replan/step/complete", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    for (const op of ["pause", "resume", "cancel", "replan", "step", "complete"]) {
      expect(() => decode({ action: "control", workflow_id: "wf-1", operation: op })).not.toThrow()
    }
  })

  it("control operation rejects unknown operations", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "control", workflow_id: "wf-1", operation: "delete" })).toThrow()
    expect(() => decode({ action: "control", workflow_id: "wf-1", operation: "start" })).toThrow()
  })

  it("keeps workflow graph and admission internals out of tool-call parameters", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(decode({
      action: "start",
      spec_path: ".opencode/workflows/deep.yaml",
      mode: "deep",
      admission: admissionFor("READY", "CONSUMED"),
      config: {
        name: "deep-schema",
        nodes: [],
      },
    })).toEqual({
      action: "start",
      spec_path: ".opencode/workflows/deep.yaml",
    })
  })

})

describe("workflow tool execution", () => {
  runtime.effect("description retains the workflow action reference after guidance migration", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()

      for (const action of ["start", "extend", "status", "control"]) {
        expect(workflow.description).toContain(`**${action}**`)
      }
      expect(workflow.description).toContain("Do not poll")
      expect(workflow.description).not.toContain("$ARGUMENTS")
    }),
  )

  runtime.effect("status returns the durable workflow and node state", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        {
          action: "status",
          workflow_id: "dag_status",
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(result.output).toContain('"status": "running"')
      expect(result.output).toContain('"id": "node_running"')
      expect(result.output).toContain('"child_session_id": "ses_child"')
      expect(result.output).toContain('"mode": "standard"')
    }),
  )

  runtime.effect("status and recovery reads retain consumed deep admission audit fields", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        {
          action: "status",
          workflow_id: "dag_deep_status",
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      const output = JSON.parse(result.output)
      expect(output).toEqual(expect.objectContaining({
        mode: "deep",
        admission: {
          verdict: "WAIVED",
          state: "CONSUMED",
          qa_mode: "STANDARD",
          brief_revision: 1,
          fingerprint: admissionFor("WAIVED").fingerprint,
          waiver_reason: "Preview release only",
          acknowledged_risks: ["Production rollout is unresolved"],
        },
      }))
      expect(output.admission).not.toHaveProperty("qa_transcript")
    }),
  )

  runtime.effect("deep start repairs one YAML file and owns admission audit fields", () =>
    Effect.gen(function* () {
      published.length = 0
      const specPath = path.join(workflowSpecDirectory, "deep.yaml")
      yield* Effect.promise(() =>
        Bun.write(
          specPath,
          `title: Deep ready
mode: deep
admission:
  brief_revision: 1
  qa_mode: STANDARD
  verdict: READY
config:
  name: deep-ready
  nodes: []
`,
        ),
      )

      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const context = {
        sessionID: SessionID.make("ses_workflow_parent"),
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } satisfies Tool.Context
      const invalid = yield* workflow.execute(
        {
          action: "start",
          spec_path: "deep.yaml",
        },
        context,
      ).pipe(Effect.exit)

      expect(Exit.isFailure(invalid)).toBe(true)
      if (Exit.isFailure(invalid)) {
        expect(Cause.pretty(invalid.cause)).toContain('["admission"]["brief"]')
      }
      expect(published).toHaveLength(0)

      yield* Effect.promise(() =>
        Bun.write(
          specPath,
          `title: Deep ready
mode: deep
admission:
  protocol_version: 999
  brief_revision: 1
  qa_mode: STANDARD
  verdict: READY
  state: CONSUMED
  fingerprint: ${"0".repeat(64)}
  brief:
    goal: Qualify and execute a deep workflow
    scope:
      in: [workflow start, review lifecycle]
      out: [new admission UI]
    constraints: [standard workflows stay compatible]
    assumptions: [the parent session can ask questions]
    acceptance_criteria: [deep start requires READY or WAIVED]
    evidence_required: [unit tests, integration tests]
    risks: [waiver misuse]
    review_plan: [verify, review the implementation diff]
    open_questions: []
    blocking_questions: []
config:
  name: deep-ready
  nodes: []
`,
        ),
      )

      const result = yield* workflow.execute(
        {
          action: "start",
          spec_path: "deep.yaml",
        },
        context,
      )

      expect(result.output).toContain('mode="deep"')
      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(created.config ?? "{}")).toEqual(expect.objectContaining({
        mode: "deep",
        admission: expect.objectContaining({
          protocol_version: 1,
          verdict: "READY",
          state: "CONSUMED",
          fingerprint: fingerprintBrief(admissionBrief),
        }),
      }))
    }),
  )

  runtime.effect("invalid YAML reports its source file without workflow side effects", () =>
    Effect.gen(function* () {
      published.length = 0
      const specPath = path.join(workflowSpecDirectory, "invalid.yaml")
      yield* Effect.promise(() => Bun.write(specPath, "config:\n  nodes: [\n"))
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const exit = yield* workflow.execute(
        {
          action: "start",
          spec_path: specPath,
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(`Invalid workflow YAML ${specPath}:`)
      }
      expect(published).toHaveLength(0)
    }),
  )

  runtime.effect("start derives the project ID from the parent session", () =>
    Effect.gen(function* () {
      published.length = 0
      const parentID = SessionID.make("ses_workflow_parent")
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("project-id-regression", {
        config: {
          name: "project-id-regression",
          nodes: [],
        },
      })

      const result = yield* workflow.execute(
        {
          action: "start",
          spec_path: specPath,
        },
        {
          sessionID: parentID,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      const workflowID = result.metadata.workflowId
      expect(workflowID).toBeDefined()
      expect(result.output).toContain("Do not poll")
      expect(published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data).toEqual(
        expect.objectContaining({ projectID, sessionID: parentID }),
      )
      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(created.config ?? "{}").mode).toBe("standard")
    }),
  )

  missingModelRuntime.effect("start asks QA and creates nothing when no model can be resolved", () =>
    Effect.gen(function* () {
      published.length = 0
      questionsAsked.length = 0
      missingModelDirectory = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "workflow-model-"))),
        (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
      )
      yield* Effect.promise(() => fs.mkdir(path.join(missingModelDirectory, ".opencode"), { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(missingModelDirectory, ".opencode", "dag.jsonc"),
          '{ "model": {} }\n',
        )
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(missingModelDirectory, "missing-model.yaml"),
          JSON.stringify({
            config: {
              name: "missing-model",
              nodes: [{
                id: "worker",
                name: "Worker",
                worker_type: "build",
                depends_on: [],
                prompt_template: { inline: "work" },
              }],
            },
          }),
        )
      )

      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        {
          action: "start",
          spec_path: "missing-model.yaml",
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(result.title).toBe("Workflow not started: model required")
      expect(result.metadata.workflowId).toBeUndefined()
      expect(questionsAsked).toHaveLength(1)
      expect(questionsAsked[0]?.question).toContain('"worker"')
      expect(published).toHaveLength(0)
    }),
  )

  runtime.effect("deep start consumes and retains an informed WAIVED admission", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("deep-waived", {
        mode: "deep",
        admission: admissionInputFor("WAIVED"),
        config: {
          name: "deep-waived",
          nodes: [],
        },
      })
      yield* workflow.execute(
        {
          action: "start",
          spec_path: specPath,
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(created.config ?? "{}").admission).toEqual(expect.objectContaining({
        verdict: "WAIVED",
        state: "CONSUMED",
        waiver_reason: "Preview release only",
        acknowledged_risks: ["Production rollout is unresolved"],
      }))
    }),
  )

  runtime.effect("deep start blocks missing or non-ready admission without side effects", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const cases = [
        {
          name: "missing",
          value: {
            mode: "deep",
            config: {
              name: "deep-missing",
              nodes: [],
            },
          },
        },
        {
          name: "not-ready",
          value: {
            mode: "deep",
            admission: admissionInputFor("NOT_READY"),
            config: {
              name: "deep-not-ready",
              nodes: [],
            },
          },
        },
        {
          name: "waived-without-audit",
          value: {
            mode: "deep",
            admission: {
              ...admissionInputFor("WAIVED"),
              waiver_reason: undefined,
              acknowledged_risks: undefined,
            },
            config: {
              name: "deep-waived-without-audit",
              nodes: [],
            },
          },
        },
      ]

      for (const item of cases) {
        published.length = 0
        const specPath = yield* writeWorkflowSpec(`blocked-${item.name}`, item.value)
        const exit = yield* workflow.execute(
          {
            action: "start",
            spec_path: specPath,
          },
          {
            sessionID: SessionID.make("ses_workflow_parent"),
            messageID: MessageID.ascending(),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          } satisfies Tool.Context,
        ).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(published).toHaveLength(0)
      }
    }),
  )

  runtime.effect("start passes the decoded required default to Dag.create", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("required-default", {
        config: {
          name: "required-default",
          nodes: [
            {
              id: "optional-node",
              name: "Optional node",
              worker_type: "build",
              depends_on: [],
              prompt_template: { inline: "work" },
            },
          ],
        },
      })

      yield* workflow.execute(
        {
          action: "start",
          spec_path: specPath,
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({ required: false }),
      )
    }),
  )

  runtime.effect("start resolves omitted values from workflow config defaults", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("configured-defaults", {
        config: {
          name: "configured-defaults",
          node_defaults: {
            required: true,
            report_to_parent: true,
            worker_config: { timeout_ms: 1234 },
          },
          nodes: [
            {
              id: "inherits",
              name: "Inherits defaults",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "work" },
            },
            {
              id: "overrides",
              name: "Overrides defaults",
              worker_type: "general",
              depends_on: [],
              required: false,
              report_to_parent: false,
              worker_config: { timeout_ms: 4321 },
              prompt_template: { inline: "work" },
            },
          ],
        },
      })

      yield* workflow.execute(
        {
          action: "start",
          spec_path: specPath,
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data as {
        config?: string
      }
      const config = JSON.parse(created.config ?? "{}")
      expect(config).toEqual(
        expect.objectContaining({
          max_concurrency: 5,
          max_node_replan_attempts: 5,
          max_total_nodes: 100,
        }),
      )
      expect(config.nodes[0]).toEqual(
        expect.objectContaining({
          required: true,
          report_to_parent: true,
          worker_config: { timeout_ms: 1234 },
        }),
      )
      expect(config.nodes[1]).toEqual(
        expect.objectContaining({
          required: false,
          report_to_parent: false,
          worker_config: { timeout_ms: 4321 },
        }),
      )
    }),
  )

  runtime.effect("extend resolves new nodes from the persisted workflow defaults", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("extend-defaults", {
        nodes: [
          {
            id: "added",
            name: "Added node",
            worker_type: "general",
            depends_on: [],
            prompt_template: { inline: "work" },
          },
        ],
      })

      yield* workflow.execute(
        {
          action: "extend",
          workflow_id: "dag_defaults",
          spec_path: specPath,
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({
          nodeID: "added",
          required: true,
          model: {
            providerID: "local-proxy-compatible",
            modelID: "glm-5.2",
          },
        }),
      )
      const updated = published.find((event) => event.type === DagEvent.WorkflowConfigUpdated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(updated.config ?? "{}").nodes[0]).toEqual(
        expect.objectContaining({
          report_to_parent: true,
          worker_config: { timeout_ms: 1234 },
        }),
      )
    }),
  )

  runtime.effect("replan resolves new nodes from the persisted workflow defaults", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("replan-defaults", {
        fragment: {
          name: "replan-fragment",
          nodes: [
            {
              id: "replanned",
              name: "Replanned node",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "work" },
            },
          ],
        },
      })

      yield* workflow.execute(
        {
          action: "control",
          workflow_id: "dag_defaults",
          operation: "replan",
          spec_path: specPath,
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({
          nodeID: "replanned",
          required: true,
          model: {
            providerID: "local-proxy-compatible",
            modelID: "glm-5.2",
          },
        }),
      )
      const updated = published.find((event) => event.type === DagEvent.WorkflowConfigUpdated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(updated.config ?? "{}").nodes[0]).toEqual(
        expect.objectContaining({
          report_to_parent: true,
          worker_config: { timeout_ms: 1234 },
        }),
      )
    }),
  )

  runtime.effect("start rejects a project ID outside the parent session project", () =>
    Effect.gen(function* () {
      published.length = 0
      const parentID = SessionID.make("ses_workflow_parent")
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const exit = yield* workflow
        .execute(
          {
            action: "start",
            project_id: "project_other",
            spec_path: "project-id-mismatch.yaml",
          },
          {
            sessionID: parentID,
            messageID: MessageID.ascending(),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          } satisfies Tool.Context,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(published).toHaveLength(0)
    }),
  )
})
