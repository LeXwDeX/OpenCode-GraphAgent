import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CommandV2 } from "@opencode-ai/core/command"
import { Location } from "@opencode-ai/core/location"
import { CommandPlugin } from "@opencode-ai/core/plugin/command"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const directory = AbsolutePath.make("/repo/packages/app")
const project = AbsolutePath.make("/repo")
const it = testEffect(
  CommandV2.locationLayer.pipe(
    Layer.provide(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory }, { projectDirectory: project }))),
    ),
  ),
)

describe("CommandPlugin.Plugin", () => {
  it.effect("registers built-in init and review commands", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      yield* CommandPlugin.Plugin.effect(
        host({
          command: { transform: command.transform, reload: command.reload },
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory }, { projectDirectory: project })),
        ),
      )

      expect(yield* command.get("init")).toMatchObject({
        name: "init",
        description: "guided AGENTS.md setup",
      })
      expect((yield* command.get("init"))?.template).toContain("`/repo`")
      expect(yield* command.get("review")).toMatchObject({
        name: "review",
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        subtask: true,
      })
      expect(yield* command.get("dag-flow")).toMatchObject({
        name: "dag-flow",
        description: CommandPlugin.DagFlowDescription,
        template: CommandPlugin.DagFlowContent,
      })
      expect(CommandPlugin.DagFlowContent).toContain("$ARGUMENTS")
      expect(CommandPlugin.DagFlowContent).toContain("workflow` tool with `action=start")
      expect(CommandPlugin.DagFlowContent).toContain("exact Workflow ID")
      expect(CommandPlugin.DagFlowContent).toContain("run `/dag`")
    }),
  )

  it.effect("documents the smallest execution mode and conservative implicit DAG trigger", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowContent).toContain("## Execution Mode Selection")
      expect(CommandPlugin.WorkflowContent).toContain("direct execution")
      expect(CommandPlugin.WorkflowContent).toContain("single `task` subagent")
      expect(CommandPlugin.WorkflowContent).toContain("both a scenario signal and a structural signal")
      expect(CommandPlugin.WorkflowFactsContent).toContain("both a scenario")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("when ANY")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("- **Multi-model**:")
      expect(CommandPlugin.DagFlowContent).toContain("workflow` tool with `action=start")
    }),
  )

  it.effect("preserves opt-outs read-only scope and explicit role assignments", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("single agent")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("do not use DAG")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("answer directly")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain('"Do not modify files"')
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("explicit `@agent` assignment")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT invent a `worker_type`")
    }),
  )

  it.effect("documents config-first model fallback without invented identifiers", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Omit `node.model` by default")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "`node.model` → `config.node_defaults.model` → configured agent model → parent session model",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("exact provider/model pair")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("providerID")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("provider-local `modelID`")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT invent a model identifier")
    }),
  )

  it.effect("defines adaptive brainstorm review and develop profiles", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Profile: Brainstorm")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("at least two independent viewpoint")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("fan in to one synthesizer")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Profile: Review")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("distinct review dimensions")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("one downstream arbiter")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Profile: Develop")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("interface and TDD")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Omit phases whose evidence is already satisfied")
    }),
  )

  it.effect("distinguishes required-node failure from business verdicts", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("`required: true` handles execution failure")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("does not interpret a successful business verdict")
      for (const verdict of ["ACCEPT", "REVISE", "REJECT", "BLOCKED"]) {
        expect(CommandPlugin.OrchestrationPolicyContent).toContain(verdict)
      }
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("output_schema")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("condition")
    }),
  )

  it.effect("defines actionable checkpoints and bounded acyclic repair", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("report_to_parent: false")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("report_to_parent: true")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain('"next_action"')
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Do not poll")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("`extend` or `control(replan)`")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT create cyclic `depends_on`")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("max_node_replan_attempts")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("stop with `BLOCKED`")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("do not retry the identical plan")
    }),
  )

  it.effect("defines parent-session admission fixtures for standard deep and GRILL requests", () =>
    Effect.sync(() => {
      const fixtures = [
        {
          name: "simple request remains standard",
          expected: "Simple or already-bounded work stays `standard`",
        },
        {
          name: "qualified complex request recommends deep",
          expected: "at least two deep-complexity signals",
        },
        {
          name: "explicit deep enters admission",
          expected: "Explicit `deep` intent still requires admission",
        },
        {
          name: "questions stay in the parent session",
          expected: "MUST NOT create an admission child node",
        },
        {
          name: "explicit GRILL-ME selects adversarial QA",
          expected: "`GRILL-ME` selects `GRILL`",
        },
      ]

      for (const fixture of fixtures) {
        expect(
          CommandPlugin.OrchestrationPolicyContent,
          fixture.name,
        ).toContain(fixture.expected)
      }
    }),
  )

  it.effect("defines bounded Requirement Brief verdict and recovery contracts", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Deep Admission QA")
      for (const dimension of [
        "goal",
        "scope",
        "constraints and assumptions",
        "acceptance criteria",
        "evidence and review",
        "risks and failure modes",
      ]) {
        expect(CommandPlugin.OrchestrationPolicyContent).toContain(dimension)
      }
      for (const field of [
        "acceptance_criteria",
        "evidence_required",
        "review_plan",
        "open_questions",
        "blocking_questions",
      ]) {
        expect(CommandPlugin.OrchestrationPolicyContent).toContain(field)
      }
      expect(CommandPlugin.OrchestrationPolicyContent).toContain('"in": []')
      expect(CommandPlugin.OrchestrationPolicyContent).toContain('"out": []')
      expect(CommandPlugin.OrchestrationPolicyContent).not.toContain("in_scope")
      expect(CommandPlugin.OrchestrationPolicyContent).not.toContain("out_of_scope")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("`LIGHT`: at most 1 question round")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("`STANDARD`: at most 3 question rounds")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("`GRILL`: at most 5 question rounds")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Stop early as soon as the brief is ready")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("READY | NOT_READY | WAIVED")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("continue QA, reduce scope, use `standard`, or explicitly waive")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("waiver_reason")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("acknowledged_risks")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Material changes")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("invalidate the prior fingerprint")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("SHA-256 hash")
      expect(CommandPlugin.WorkflowFactsContent).toContain(
        "pass `mode: deep` plus a versioned `READY` or informed `WAIVED` admission",
      )
      expect(CommandPlugin.WorkflowFactsContent).toContain(
        "beside `config` in the `action: start` tool call",
      )
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("`config.mode`")
    }),
  )

  it.effect("documents truthful design and diff review production topologies", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("design review → implementation")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "implementation → verification(PASS) → diff review → final gate/audit",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "REJECT → corrected implementation → verification(PASS) → new diff review",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "Synthetic stress-test graphs",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "MUST NOT claim implementation-diff assurance",
      )
    }),
  )

  it.effect("keeps workflow examples aligned with runtime data flow and safety", () =>
    Effect.sync(() => {
      const graphExamples = [...CommandPlugin.WorkflowFactsContent.matchAll(/```yaml\n([\s\S]*?)```/g)]
        .map((match) => match[1] ?? "")
        .filter((example) => example.includes("nodes:"))

      expect(graphExamples.length).toBeGreaterThan(0)
      for (const example of graphExamples) {
        expect(example).toContain("action: start\nconfig:")
        expect(example).toMatch(/\n  nodes:/)
        expect(example).not.toMatch(/^nodes:/m)
        expect(example.match(/^\s+- id:/gm)?.length).toBe(example.match(/^ {6}name:/gm)?.length)
        expect(example.match(/^\s+- id:/gm)?.length).toBe(example.match(/^ {6}depends_on:/gm)?.length)
      }
      expect(CommandPlugin.WorkflowFactsContent).toContain("input_mapping:")
      expect(CommandPlugin.WorkflowFactsContent).toContain("findings: explore")
      expect(CommandPlugin.WorkflowFactsContent).toContain('condition: \'gate.output.verdict == "ACCEPT"\'')
      expect(CommandPlugin.WorkflowFactsContent).not.toContain('input: { findings: "from explore" }')
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("Gate failure cancels the workflow automatically")
      expect(CommandPlugin.WorkflowFactsContent).toContain("Static `prompt_template.input`")
      expect(CommandPlugin.WorkflowFactsContent).toContain("provider-local model ID")
      expect(CommandPlugin.WorkflowFactsContent).toContain("agent model and then the parent session model")
      expect(CommandPlugin.WorkflowFactsContent).toContain("Propose-then-assemble")
      const reviewExample = CommandPlugin.WorkflowFactsContent
        .slice(
          CommandPlugin.WorkflowFactsContent.indexOf("### 3. Adversarial Review"),
          CommandPlugin.WorkflowFactsContent.indexOf("### 4. Diverge-Converge"),
        )
      expect(reviewExample).toContain("report_to_parent: true")
      expect(reviewExample).toContain("output_schema:")
      expect(reviewExample).toContain("required: [verdict, summary, findings, required_actions, next_action]")
      expect(reviewExample).toContain("required: [operation, targets]")
      expect(reviewExample).toContain("enum: [continue, extend, replan, complete, stop]")
      expect(CommandPlugin.WorkflowFactsContent).toContain("an early\n`control(complete)` workflow remains terminal")
      expect(CommandPlugin.DagFlowContent).toContain("must actually contain the requested synthesis")
    }),
  )
})
