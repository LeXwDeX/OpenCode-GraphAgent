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
      expect(yield* command.get("dag-auto")).toMatchObject({
        name: "dag-auto",
        description: CommandPlugin.DagAutoDescription,
        template: CommandPlugin.DagAutoContent,
      })
      expect(CommandPlugin.DagAutoContent).toContain("$ARGUMENTS")
      expect(CommandPlugin.DagAutoContent).toContain("ultra-flow-route")
      expect(CommandPlugin.DagAutoContent).toContain("continue|replan")
      expect(CommandPlugin.DagAutoContent).toContain("3 back-edges")
      expect(CommandPlugin.DagAutoContent).toContain("Product decision checkpoint")
    }),
  )

  it.effect("retires the platform-delivery commands", () =>
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

      expect(yield* command.get("dag-init")).toBeUndefined()
      expect(yield* command.get("dag-flow")).toBeUndefined()
      expect(yield* command.get("dag-template-update")).toBeUndefined()
    }),
  )

  it.effect("keeps /dag-auto free of platform-delivery vocabulary", () =>
    Effect.sync(() => {
      const content = CommandPlugin.DagAutoContent
      expect(content).not.toContain("dag-init")
      // The intro/Rules name the boundary in the negative ("no issues, no
      // PRs"); actionable delivery mechanics must stay absent.
      expect(content).not.toContain("issue number")
      expect(content).not.toContain("gh pr")
      expect(content).not.toContain("pr checks")
      expect(content).not.toContain("Ordered merge")
      expect(content).not.toContain("rebase")
      expect(content).not.toContain("release brief")
      expect(content).toContain("routing and workflow-composition")
      expect(content).toContain("workflow(action=\"list\")")
      expect(content).toContain("workflow(action=\"validate\")")
      expect(content).toContain("workflow(action=\"start\")")
    }),
  )

  it.effect("documents the smallest child execution mode", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowContent).toContain("## Execution mode")
      expect(CommandPlugin.WorkflowContent).toContain("Direct execution:")
      expect(CommandPlugin.WorkflowContent).toContain("One `task` child")
      expect(CommandPlugin.WorkflowContent).toContain("Related work for one objective")
      expect(CommandPlugin.WorkflowContent).toContain("project-level source or test changes")
      expect(CommandPlugin.WorkflowContent).toMatch(/even one project\s+file/)
      expect(CommandPlugin.WorkflowFactsContent).toContain("resident\nOrchestration Router owns execution-mode")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("## When to start a workflow")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("when ANY")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("- **Multi-model**:")
      expect(CommandPlugin.DagAutoContent).toContain('workflow(action="start")')
    }),
  )

  it.effect("keeps always-on guidance small and loads detailed topics progressively", () =>
    Effect.sync(() => {
      // Budget admits the inline start-spec example (one-hop field reference
      // for hand-written YAML) while keeping per-action manuals progressive.
      expect(Buffer.byteLength(CommandPlugin.WorkflowContent)).toBeLessThan(6_500)
      expect(CommandPlugin.WorkflowContent).toContain("project-level source or test changes")
      expect(CommandPlugin.WorkflowContent).toMatch(/even one project\s+file/)
      expect(CommandPlugin.WorkflowContent).toMatch(/isolated utility\s+scripts/)
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

  it.effect("selects one saved reference by outcome and escalates risk to full", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowContent).toMatch(/call\s+`workflow\(action="list"\)` before authoring/)
      expect(CommandPlugin.WorkflowContent).toContain("never guess a route name")
      expect(CommandPlugin.WorkflowContent).toContain("exactly one primary saved reference")
      ;[
        "product planning",
        "technical design",
        "project development",
        "debug and repair",
        "code review",
        "security audit",
        "performance audit",
      ].forEach((domain) => expect(CommandPlugin.WorkflowContent).toContain(domain))
      expect(CommandPlugin.WorkflowContent).toMatch(/Use `lite` only when all/)
      expect(CommandPlugin.WorkflowContent).toMatch(/Use\s+`full`\s+when any/)
      expect(CommandPlugin.WorkflowContent).toContain("upstream executable dependencies")
      expect(CommandPlugin.WorkflowContent).toContain("single matching custom workflow")
      expect(CommandPlugin.WorkflowContent).toContain("Do not concatenate two complete references")
      expect(CommandPlugin.WorkflowContent).toContain("never role count or block count, which are consequences of risk")
      expect(CommandPlugin.WorkflowContent).toContain("dispose of the verdict under the Verdict Disposal Contract")
      expect(CommandPlugin.WorkflowContent).toContain("the correction wave MUST be full-shaped")
      expect(CommandPlugin.WorkflowContent).toContain("Do not pause or replan a completed workflow")
    }),
  )

  it.effect("keeps the parent at macro level and consolidates related work", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("The parent conversation owns")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT perform executable leaf work")
      expect(CommandPlugin.OrchestrationPolicyContent).not.toContain("## Execution Mode Selection")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("持续核验至上线标准 · Verify to the delivery bar")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("keep iterating verification until the")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("only the user's delivery standard")
      expect(CommandPlugin.WorkflowContent).toContain("One `task` child")
      expect(CommandPlugin.WorkflowContent).toContain("One `workflow` DAG")
      expect(CommandPlugin.DagAutoContent).toContain("ONE consolidated summary")
    }),
  )

  it.effect("uses file-backed specs for one-off and saved workflows", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowFactsContent).toContain("write the graph to a")
      expect(CommandPlugin.WorkflowFactsContent).toContain("task-local file")
      // The resident description keeps tool selection and the progressive
      // guide index only; per-action field semantics live in the parameter
      // schema (change repair-workflow-authoring-validation).
      expect(CommandPlugin.WorkflowContent).not.toContain("## Actions")
      expect(CommandPlugin.WorkflowContent).toContain("parameter schema")
      expect(CommandPlugin.WorkflowFactsContent).toContain('{ action: "read", spec_path: "<name-returned-by-list>" }')
      expect(CommandPlugin.WorkflowFactsContent).toContain("use only an exact returned name")
      expect(CommandPlugin.WorkflowFactsContent).not.toContain('spec_path: "code-review"')
      expect(CommandPlugin.WorkflowFactsContent).toMatch(/Retarget its\s+objective and block instructions/)
      expect(CommandPlugin.WorkflowFactsContent).not.toContain("pass `spec` inline")
      expect(CommandPlugin.DagAutoContent).toContain(".opencode/.dag-specs/")
      expect(CommandPlugin.DagAutoContent).toContain("retarget")
    }),
  )

  it.effect("publishes an exact block YAML authoring contract", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowBlocksContent).toContain("Never infer or invent a YAML field")
      expect(CommandPlugin.WorkflowBlocksContent).toContain("### Start file")
      expect(CommandPlugin.WorkflowBlocksContent).toContain("### Extend file")
      expect(CommandPlugin.WorkflowBlocksContent).toContain("### Replan file")
      expect(CommandPlugin.WorkflowBlocksContent).toMatch(
        /`id`, `kind`, `depends_on`, `instruction`,\s+`worker_type`, `required`, and `report_to_parent`/,
      )
      expect(CommandPlugin.WorkflowBlocksContent).toMatch(
        /`action`, `workflow_id`, `operation`, and `spec_path` are tool-call fields/,
      )
      const authoringContract = CommandPlugin.WorkflowBlocksContent.slice(
        CommandPlugin.WorkflowBlocksContent.indexOf("## Authoring contract"),
        CommandPlugin.WorkflowBlocksContent.indexOf("This guide owns"),
      )
      expect(authoringContract).toMatch(/[Tt]he\s+listed YAML fields are exhaustive/)
      expect(authoringContract).not.toMatch(
        /session_id|project_id|protocol_version|fingerprint|node_defaults\.model|node\.model/,
      )
      expect(CommandPlugin.WorkflowBlocksContent).toContain(
        '{ action: "control", operation: "replan", workflow_id: "dag_...", spec_path: "replan.yaml" }',
      )
    }),
  )

  it.effect("preserves opt-outs read-only scope and explicit role assignments", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowContent).toContain("one agent, direct work, or no DAG")
      expect(CommandPlugin.WorkflowContent).toContain("A read-only request")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("explicit `@agent` assignment")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT invent a `worker_type`")
    }),
  )

  it.effect("documents config-first model fallback without invented identifiers", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Workflow YAML has no model-selection field")
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
    }),
  )

  it.effect("grades the review profile and mandates claim verification", () =>
    Effect.sync(() => {
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("four waves minimum")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("unverified_claims")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("claim-verification wave")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("MUST NOT be a silent end of the graph")
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
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Classify the findings first; the class selects the option")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("The situation itself was misclassified")
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("Role or block count never selects a tier")
      expect(CommandPlugin.WorkflowFactsContent).toContain("Verdict Disposal Contract")
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
      expect(CommandPlugin.OrchestrationPolicyContent).not.toContain('"next_action"')
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("The child reports evidence and required actions only")
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

  it.effect("keeps cross-domain composition separate from route selection", () =>
    Effect.sync(() => {
      expect(CommandPlugin.WorkflowContent).not.toContain("# Orchestration Domains")
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("# Cross-domain Workflow Composition")
      for (const outcome of [
        "The requested deliverable is a product decision",
        "The requested deliverable is an implementation-ready design",
        "The requested deliverable is changed code",
        "The requested deliverable is a defect repair",
        "The requested deliverable is a verdict",
      ]) {
        expect(CommandPlugin.OrchestrationDomainsContent).toContain(outcome)
      }
      expect(CommandPlugin.OrchestrationDomainsContent).toContain("secondary assurance")
      expect(CommandPlugin.OrchestrationDomainsContent).toMatch(/never a\s+second workflow/)
      expect(CommandPlugin.OrchestrationDomainsContent).not.toContain("## Playbook:")
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
      expect(CommandPlugin.OrchestrationPolicyContent).toContain("invalidate the prior admission record")
      const admissionPolicy = CommandPlugin.OrchestrationPolicyContent.slice(
        CommandPlugin.OrchestrationPolicyContent.indexOf("## Deep Admission QA"),
        CommandPlugin.OrchestrationPolicyContent.indexOf("## Role Resolution"),
      )
      expect(admissionPolicy).not.toMatch(/protocol_version|fingerprint/)
      expect(CommandPlugin.WorkflowFactsContent).toContain(
        "The start spec places `mode: deep`, a versioned `READY` or informed `WAIVED`",
      )
      expect(CommandPlugin.WorkflowFactsContent).toContain("The admission input accepts\nonly `brief_revision`")
      expect(CommandPlugin.WorkflowFactsContent).not.toMatch(/protocol_version|node_defaults\.model|node\.model/)
      expect(CommandPlugin.WorkflowFactsContent).toContain("A one-off graph may use a")
      expect(CommandPlugin.WorkflowFactsContent).toContain("task-local file")
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
      expect(CommandPlugin.WorkflowFactsContent).toContain("Workflow YAML has no model-selection field")
      expect(CommandPlugin.WorkflowFactsContent).toMatch(
        /`dag\.jsonc`\s+tier, then the\s+configured agent model, then the parent-session model/,
      )
      expect(CommandPlugin.WorkflowFactsContent).toContain("Propose-then-assemble")
      const reviewExample = CommandPlugin.WorkflowFactsContent.slice(
        CommandPlugin.WorkflowFactsContent.indexOf("### 3. Adversarial Review"),
        CommandPlugin.WorkflowFactsContent.indexOf("### 4. Diverge-Converge"),
      )
      expect(reviewExample).toContain("report_to_parent: true")
      expect(reviewExample).toContain("output_schema:")
      expect(reviewExample).toContain("required: [verdict, summary, findings, required_actions]")
      expect(reviewExample).not.toContain("next_action")
      expect(reviewExample).toContain("The parent chooses any workflow control action")
      // The arbiter must not be a silent terminal leaf: a conditioned
      // continuation node keeps non-ACCEPT verdicts from dead-ending the graph.
      expect(reviewExample).toContain("condition: 'arbitrate.output.verdict != \"ACCEPT\"'")
      expect(CommandPlugin.WorkflowFactsContent).toContain("an early\n`control(complete)` workflow remains terminal")
      expect(CommandPlugin.WorkflowFactsContent).toContain("project, global, and builtin scopes")
      expect(CommandPlugin.WorkflowFactsContent).toContain("bounded objectives")
      expect(CommandPlugin.WorkflowFactsContent).toContain("validation status")
    }),
  )
})
