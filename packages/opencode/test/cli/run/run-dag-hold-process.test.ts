// Subprocess integration tests for the consumer-only DAG hold (issue 614).
// Each test drives the real `opencode run` CLI binary against the in-process
// TestLLMServer (same harness as run-process.test.ts): a scripted provider
// plays the parent model, workflow children, and wake turns; assertions cover
// the child process exit code and stdout ordering. The DAG engine itself is
// production code here — workflows are started through the real `workflow`
// tool from YAML specs written into the isolated test home.
//
// Stdout carries ONLY assistant text parts of the target session (tool lines
// and headers go to stderr), so each case can assert exact stdout: the turn-1
// continuation line proves the loop survived the first idle, and the final
// wake line proves the hold kept the process alive for the wake turn.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

const SKIP_PERMISSIONS = ["--dangerously-skip-permissions"]

function bodyIncludes(marker: string) {
  return (hit: { body: unknown }) => JSON.stringify(hit.body).includes(marker)
}

const wakeCompleted = bodyIncludes("[DAG Workflow completed]")

// Two-node chain, the last node reporting to the parent: the s4 shape —
// workflow started in turn one, children complete, the workflow terminalizes
// and wakes the parent.
const chainSpec = `title: cli-hold-chain
config:
  name: cli-hold-chain
  nodes:
    - id: first
      name: first
      worker_type: general
      depends_on: []
      prompt_template:
        inline: "S4-FIRST marker: do the first unit of work."
    - id: final
      name: final
      worker_type: general
      depends_on: [first]
      prompt_template:
        inline: "S4-FINAL marker: summarize the work."
      report_to_parent: true
`

// Single schemaless node that settles from its plain text reply.
const singleSpec = `title: cli-hold-single
config:
  name: cli-hold-single
  nodes:
    - id: only
      name: only
      worker_type: general
      depends_on: []
      prompt_template:
        inline: "EARLY-SINGLE marker: do the work."
      report_to_parent: true
`

// Required node declaring an output_schema the child never satisfies (the
// auto-reply never calls submit_result): deterministic verdict_fail bound.
const failSpec = `title: cli-hold-failure
config:
  name: cli-hold-failure
  nodes:
    - id: must
      name: must
      worker_type: general
      depends_on: []
      required: true
      prompt_template:
        inline: "FAIL-BOUND marker: produce the structured verdict."
      output_schema:
        type: object
        properties:
          verdict:
            type: string
            enum: [GO]
        required: [verdict]
        additionalProperties: false
`

// Reporting checkpoint with a gated dependent: the gate child submits a
// "replan" verdict, the workflow pauses at the checkpoint (durable, survives
// the process), and the dependent only runs after an explicit resume.
const checkpointSpec = `title: cli-hold-checkpoint
config:
  name: cli-hold-checkpoint
  nodes:
    - id: gate
      name: gate
      worker_type: general
      depends_on: []
      report_to_parent: true
      output_schema:
        type: object
        properties:
          verdict:
            type: string
            enum: [replan]
        required: [verdict]
        additionalProperties: false
      prompt_template:
        inline: "ADOPT-GATE marker: adjudicate the plan."
    - id: final
      name: final
      worker_type: general
      depends_on: [gate]
      condition: 'gate.output.verdict == "replan"'
      prompt_template:
        inline: "ADOPT-FINAL marker: finish the work."
`

function writeSpec(home: string, name: string, content: string) {
  return Effect.promise(() => Bun.write(path.join(home, name), content))
}

describe("opencode run DAG hold (issue 614)", () => {
  cliIt.concurrent(
    "no-DAG single-turn prompt exits with the exact reply",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("plain exact reply")
        const result = yield* opencode.run("just talk, start no workflow")
        opencode.expectExit(result, 0)
        expect(result.stdout).toBe("plain exact reply\n")
      }),
    60_000,
  )

  // s4-style regression: the pre-hold CLI broke on the first idle while the
  // workflow was still running, losing the wake reply. Two busy->idle cycles
  // are observable here as the two stdout lines: turn one's continuation
  // ("ok" from the unmatched auto-reply) and the wake turn's reply, last.
  cliIt.concurrent(
    "holds through a running workflow and prints the final wake reply last",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const spec = path.join(home, "wf-s4.yaml")
        yield* writeSpec(home, "wf-s4.yaml", chainSpec)
        yield* llm.tool("workflow", { params: { action: "start", spec_path: spec } })
        yield* llm.pushMatch(wakeCompleted, reply().text("wake handled").stop().item())

        const result = yield* opencode.run("S4 run the two node chain", { extraArgs: SKIP_PERMISSIONS })

        opencode.expectExit(result, 0)
        expect(result.stdout).toBe("ok\nwake handled\n")
      }),
    180_000,
  )

  // The workflow terminalizes inside turn one (single fast child). The
  // parent's continuation is held on a promise released after a fixed grace so
  // the first idle poll observes an already-terminal-but-never-seen workflow —
  // the first-sighted-id condition must still hold for its wake turn. A slower
  // host only shifts which hold condition fires; the assertions hold either
  // way (the grace is a race boundary, not a readiness signal).
  cliIt.concurrent(
    "holds when the workflow terminalizes within turn one",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const spec = path.join(home, "wf-early.yaml")
        yield* writeSpec(home, "wf-early.yaml", singleSpec)
        let release: () => void = () => {}
        const released = new Promise<void>((resolve) => {
          release = resolve
        })
        yield* llm.tool("workflow", { params: { action: "start", spec_path: spec } })
        yield* llm.pushMatch(
          bodyIncludes("EARLY-TOKEN"),
          reply().wait(released).text("turn one done").stop().item(),
        )
        yield* llm.pushMatch(wakeCompleted, reply().text("wake handled").stop().item())

        const run = yield* opencode.startRun("EARLY-TOKEN start the single node workflow", {
          extraArgs: SKIP_PERMISSIONS,
        })
        yield* Effect.sleep("3 seconds")
        release()
        const result = yield* run.result

        opencode.expectExit(result, 0)
        expect(result.stdout).toBe("turn one done\nwake handled\n")
      }),
    150_000,
  )

  // Failure bound: the required node fails its output contract (verdict_fail),
  // the workflow terminalizes as failed, and the wake turn prints the failure
  // summary reply before a clean exit.
  cliIt.concurrent(
    "bounds failures: failed workflow delivers its wake summary and exits 0",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const spec = path.join(home, "wf-fail.yaml")
        yield* writeSpec(home, "wf-fail.yaml", failSpec)
        yield* llm.tool("workflow", { params: { action: "start", spec_path: spec } })
        yield* llm.pushMatch(bodyIncludes("[DAG Workflow failed]"), reply().text("failure acknowledged").stop().item())

        const result = yield* opencode.run("FAIL-BOUND start the required verdict node", {
          extraArgs: SKIP_PERMISSIONS,
        })

        opencode.expectExit(result, 0)
        expect(result.stdout).toBe("ok\nfailure acknowledged\n")
      }),
    180_000,
  )

  // Adoption via --continue, in two real CLI runs over one durable project:
  //   run 1 starts a gated workflow; the gate child submits a "replan" verdict
  //   and the workflow PAUSES at the checkpoint. The CLI must exit 0 after the
  //   pause wake turn (paused keeps today's exit semantics — this is also the
  //   subprocess paused bound).
  //   run 2 (--continue) adopts the paused workflow at boot, resumes it by id,
  //   and must hold through the resumed running phase to the completion wake.
  // The package test preload forces OPENCODE_DB=":memory:" and the CLI harness
  // leaks it into every subprocess (each run would see a fresh database), so
  // both runs pin a file DB inside the isolated home through the harness env
  // override — the only way a durable workflow can cross process boundaries
  // under this harness. A crash-orphaned RUNNING node can never stay running
  // across processes (recovery reconciles it to a pause by engine design), so
  // deterministic adoption necessarily goes through pause + explicit resume;
  // the running-at-adoption decision path is covered in the unit table.
  cliIt.concurrent(
    "adopts a checkpoint-paused workflow via --continue and holds through its resumed run",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const spec = path.join(home, "wf-adopt.yaml")
        yield* writeSpec(home, "wf-adopt.yaml", checkpointSpec)
        const dbEnv = { OPENCODE_DB: path.join(home, "opencode-adopt-test.db") }

        yield* llm.tool("workflow", { params: { action: "start", spec_path: spec } })
        yield* llm.pushMatch(
          bodyIncludes("ADOPT-GATE"),
          reply().tool("submit_result", { payload: { verdict: "replan" } }).item(),
        )
        yield* llm.pushMatch(bodyIncludes("[DAG Node Result"), reply().text("checkpoint seen").stop().item())

        const first = yield* opencode.run("ADOPT run the gated workflow", { extraArgs: SKIP_PERMISSIONS, env: dbEnv })
        opencode.expectExit(first, 0)
        expect(first.stdout).toBe("ok\ncheckpoint seen\n")

        // The durable workflow id appears in the recorded request bodies (the
        // start tool result and the wake summary both embed it) — exactly one
        // workflow exists in this project.
        const inputs = yield* llm.inputs
        const ids = new Set(JSON.stringify(inputs).match(/dag_[a-z0-9]+/gi) ?? [])
        expect(ids.size).toBe(1)
        const workflowID = [...ids][0]

        yield* llm.tool("workflow", {
          params: { action: "control", operation: "resume", workflow_id: workflowID },
        })
        yield* llm.pushMatch(wakeCompleted, reply().text("adopted complete").stop().item())

        const second = yield* opencode.run("ADOPT resume and finish the workflow", {
          extraArgs: ["--continue", ...SKIP_PERMISSIONS],
          env: dbEnv,
        })

        opencode.expectExit(second, 0)
        expect(second.stdout).toBe("ok\nadopted complete\n")
      }),
    240_000,
  )
})
