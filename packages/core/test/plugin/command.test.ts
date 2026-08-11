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
      expect(CommandPlugin.DagFlowContent).toContain("`action=start`")
      expect(CommandPlugin.DagFlowContent).toContain("exact Workflow ID")
      expect(CommandPlugin.DagFlowContent).toContain("run `/dag`")
      expect(CommandPlugin.DagFlowContent).toContain("resident Orchestration Router")
      expect(CommandPlugin.DagFlowContent).toContain("Decision Checkpoint")
    }),
  )

  it.effect("documents the smallest child execution mode", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowContent).toContain("## Execution mode")
      expect(CommandPlugin.WorkflowContent).toContain("Direct execution:")
      expect(CommandPlugin.WorkflowContent).toContain("One `task` child")
      expect(CommandPlugin.WorkflowContent).toContain("Related work for one objective")
      expect(CommandPlugin.WorkflowFactsContent).toContain("project-level source or test changes")
      expect(CommandPlugin.WorkflowFactsContent).toMatch(/even when only\s+one project file/)
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("when ANY")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("- **Multi-model**:")
      expect(CommandPlugin.DagFlowContent).toContain("`action=start`")
    }),
  )

  it.effect("keeps always-on guidance small and loads detailed topics progressively", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowContent.length).toBeLessThan(5_000)
      expect(CommandPlugin.WorkflowContent).toContain("project-level source or test changes")
      expect(CommandPlugin.WorkflowContent).toMatch(/even one project\s+file/)
      expect(CommandPlugin.WorkflowContent).toContain("isolated utility scripts")
      expect(CommandPlugin.WorkflowContent).toContain("# Orchestration Router")
      expect(CommandPlugin.WorkflowContent).toContain("Workflow Brief")
      expect(CommandPlugin.WorkflowContent).toContain("smallest justified graph")
      expect(CommandPlugin.WorkflowContent).not.toMatch(/load (?:the )?[`"']?orchestration-router/i)
      expect(CommandPlugin.WorkflowContent).toContain(
        "Do not discover, load, or apply an external Skill to select the workflow route",
      )
      expect(CommandPlugin.WorkflowContent).toContain('guide(topic="blocks")')
      expect(CommandPlugin.WorkflowContent).not.toContain("# Orchestration Domains")
      expect(CommandPlugin.WorkflowBlocksContent).toContain("# Composable Workflow Blocks")
      expect(CommandPlugin.WorkflowContent).toContain("combined confirmation")
      expect(CommandPlugin.WorkflowBlocksContent).not.toContain("combined confirmation")
      expect(CommandPlugin.WorkflowContent).toContain("product or architecture decision")
      expect(CommandPlugin.WorkflowBlocksContent).not.toContain("product or architecture decision")
      expect(CommandPlugin.WorkflowFactsContent.length).toBeGreaterThan(CommandPlugin.WorkflowContent.length)
    }),
  )

  it.effect("keeps the parent at macro level and consolidates related work", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("The parent conversation owns")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT perform executable leaf work")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("one `task` subagent")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("one live `workflow` DAG")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("outside a project-level source or test change")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("one user objective")
      expect(CommandPlugin.DagFlowContent).toMatch(/one consolidated\s+graph/)
    }),
  )

  it.effect("uses inline specs for one-off graphs without removing saved workflows", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowFactsContent).toContain("For a one-off graph, pass `spec` inline")
      expect(CommandPlugin.WorkflowFactsContent).toContain("Use `spec_path` only")
      // The resident description keeps tool selection and the progressive
      // guide index only; per-action field semantics live in the parameter
      // schema (change repair-workflow-authoring-validation).
      expect(CommandPlugin.WorkflowContent).not.toContain("## Actions")
      expect(CommandPlugin.WorkflowContent).toContain("parameter schema")
      expect(CommandPlugin.WorkflowFactsContent).toContain('{ action: "read", spec_path: "code-review" }')
      expect(CommandPlugin.WorkflowFactsContent).toContain("retarget its objective and block instructions")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("Never inline graph nodes")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("Before any graph-carrying action")
      expect(CommandPlugin.DagFlowContent).toContain("inline `spec`")
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
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "Never emit `node.model` or `config.node_defaults.model`",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "`dag.jsonc` tier → configured agent model → parent session model",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("workflow tool starts parent-session QA")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("does not create the\nworkflow")
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

  it.effect("binds the tiered orchestration doctrine and depth ladder", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Tiered Orchestration Doctrine")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("**Breadth (space for accuracy)**")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("**Depth (iteration for accuracy)**")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "The advanced tier MUST NOT do bulk work the standard tier can fan out",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("The standard tier MUST NOT render a final verdict")
      // Tier placement is the mechanical lever (config.ts tierModel): required/review → advanced.
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("`review`/`review-*` workers resolve to")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Depth Ladder")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("A single wave of parallel opinions is not a")
      expect(CommandPlugin.WorkflowFactsContent).toContain("Tiered Orchestration Doctrine")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("two accuracy axes")
    }),
  )

  it.effect("grades the review profile and mandates claim verification", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("four waves minimum")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("unverified_claims")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("claim-verification wave")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT be a silent end of the graph")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain(
        "**Verification wave (mandatory for module scope and larger)**",
      )
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("never the end of the task")
    }),
  )

  it.effect("binds verdict disposal at the terminal boundary", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Verdict Disposal Contract")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("same wake turn")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "Merely summarizing a non-ACCEPT verdict and ending the turn is an",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("escapes that guard")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Silence is not a stop decision")
      expect(CommandPlugin.WorkflowFactsContent).toContain("Verdict Disposal Contract")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("Verdict Disposal Contract")
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

  it.effect("defines the pause-first replan protocol", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("## Replan Protocol (pause-first)")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("IMMEDIATELY issue `control(pause)`")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("replan is valid while paused")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "Pause does not interrupt nodes that are already running",
      )
      expect(CommandPlugin.WorkflowFactsContent).toContain("always pause FIRST")
    }),
  )

  it.effect("defines productized orchestration domain playbooks", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowContent).not.toContain("# Orchestration Domains")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("## The Simulated Audit Loop")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("NOT a cyclic edge and NOT a harness loop")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("NEW ids (terminal nodes are")
      for (const playbook of [
        "## Playbook: Deep Review",
        "## Playbook: Deep Speculation",
        "## Playbook: Large Engineering",
        "## Playbook: Solution Bake-off",
        "## Playbook: Root-Cause Diagnosis",
        "## Playbook: Audit Sweeps",
      ]) {
        expect(CommandPlugin.OrchestrationDomainsContent).toContain(playbook)
      }
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("prosecutor")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("zero human gates in the middle")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("max_node_replan_attempts")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("capability slot per Role")
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
        expect(CommandPlugin.OrchestrationPolicyContent, fixture.name).toContain(fixture.expected)
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
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("combined confirmation")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("The modes control challenge depth")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("`LIGHT`: validate a nearly complete brief")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("`GRILL`: additionally probe contradictions")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("recommending an answer")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("READY | NOT_READY | WAIVED")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain(
        "continue QA, reduce scope, use `standard`, or explicitly waive",
      )
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("waiver_reason")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("acknowledged_risks")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Material changes")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("invalidate the prior fingerprint")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("SHA-256 hash")
      expect(CommandPlugin.WorkflowFactsContent).toContain(
        "The start spec places `mode: deep`, a versioned `READY` or informed `WAIVED`",
      )
      expect(CommandPlugin.WorkflowFactsContent).toContain(
        "the workflow boundary owns `protocol_version`, `state`, and\n`fingerprint`",
      )
      expect(CommandPlugin.WorkflowFactsContent).toContain("For a one-off graph, pass `spec` inline")
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
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Synthetic stress-test graphs")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT claim implementation-diff assurance")
    }),
  )

  it.effect("keeps workflow examples aligned with runtime data flow and safety", () =>
    Effect.sync(() => {
      const graphExamples = [...CommandPlugin.WorkflowFactsContent.matchAll(/```yaml\n([\s\S]*?)```/g)]
        .map((match) => match[1] ?? "")
        .filter((example) => example.includes("nodes:"))

      expect(graphExamples.length).toBeGreaterThan(0)
      for (const example of graphExamples) {
        expect(example).toMatch(/^config:/m)
        expect(example).not.toMatch(/^action:/m)
        expect(example).toMatch(/\n  nodes:/)
        expect(example).not.toMatch(/^nodes:/m)
        expect(example.match(/^\s+- id:/gm)?.length).toBe(example.match(/^ {6}name:/gm)?.length)
        expect(example.match(/^\s+- id:/gm)?.length).toBe(example.match(/^ {6}depends_on:/gm)?.length)
      }
      expect(CommandPlugin.WorkflowFactsContent).toContain("input_mapping:")
      expect(CommandPlugin.WorkflowFactsContent).toContain("findings: explore")
      expect(CommandPlugin.WorkflowFactsContent).toContain("condition: 'gate.output.verdict == \"ACCEPT\"'")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain('input: { findings: "from explore" }')
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("Gate failure cancels the workflow automatically")
      expect(CommandPlugin.WorkflowFactsContent).toContain("Static `prompt_template.input`")
      expect(CommandPlugin.WorkflowFactsContent).toContain("it must\nnever appear as `[object Object]`")
      expect(CommandPlugin.WorkflowFactsContent).toContain(
        "Workflow definitions MUST NOT specify `node.model` or\n`config.node_defaults.model`",
      )
      expect(CommandPlugin.WorkflowFactsContent).toMatch(
        /`dag\.jsonc` tier, then the\s+configured agent model, then the parent-session model/,
      )
      expect(CommandPlugin.WorkflowFactsContent).toContain("Propose-then-assemble")
      const reviewExample = CommandPlugin.WorkflowFactsContent.slice(
        CommandPlugin.WorkflowFactsContent.indexOf("### 3. Adversarial Review"),
        CommandPlugin.WorkflowFactsContent.indexOf("### 4. Diverge-Converge"),
      )
      expect(reviewExample).toContain("report_to_parent: true")
      expect(reviewExample).toContain("output_schema:")
      expect(reviewExample).toContain("required: [verdict, summary, findings, required_actions, next_action]")
      expect(reviewExample).toContain("required: [operation, targets]")
      expect(reviewExample).toContain("enum: [continue, extend, replan, complete, stop]")
      // The arbiter must not be a silent terminal leaf: a conditioned
      // continuation node keeps non-ACCEPT verdicts from dead-ending the graph.
      expect(reviewExample).toContain("condition: 'arbitrate.output.verdict != \"ACCEPT\"'")
      expect(CommandPlugin.WorkflowFactsContent).toContain("an early\n`control(complete)` workflow remains terminal")
      expect(CommandPlugin.DagFlowContent).toContain("must contain the requested result")
    }),
  )
})
