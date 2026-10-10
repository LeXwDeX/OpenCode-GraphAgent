// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Effect } from "effect"
import { mkdir, writeFile, unlink } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Global } from "@opencode-ai/core/global"
import type { DagStore } from "@opencode-ai/core/dag/store"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import type { Session } from "@/session/session"
import { PartID, SessionID } from "@/session/schema"
import { parseWorkflowConfig, type WorkflowConfig } from "../dag"
import {
  commitOutputFileRef,
  isManagedOutputFileRef,
  verifyOutputFileRef,
  type ManagedOutputFileRef,
} from "./output-ref"
import { finalAssistantText, parseFinalResponse } from "./final-response"
import { isRecord } from "@/util/record"
import { before } from "@/session/message-v2"
import { reportIdentity } from "../report-identity"

export { reportIdentity } from "../report-identity"

const INLINE_REPORT_BYTES = 64 * 1024

const newestFirst = (a: SessionV1.WithParts, b: SessionV1.WithParts) => before(a.info, b.info) ? 1 : before(b.info, a.info) ? -1 : 0

/** No guessed required node or agent name: ambiguous graphs get a stable index. */
export function selectReportNode(config: WorkflowConfig, nodes: readonly DagStore.NodeRow[]) {
  return config.delivery_node === undefined
    ? undefined
    : nodes.find((node) => node.id === config.delivery_node && !node.superseded && node.status === "completed")
}

export function resultIndex(workflow: DagStore.WorkflowRow, nodes: readonly DagStore.NodeRow[]) {
  return [
    `Workflow "${workflow.title}" completed. Results:`,
    ...nodes
      .filter((node) => !node.superseded)
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map(
        (node) => `- ${node.name} (${node.status}): workflow result workflow_id="${workflow.id}" node_id="${node.id}"`,
      ),
  ].join("\n")
}

function reportText(
  node: DagStore.NodeRow,
  config: WorkflowConfig,
  source?: SessionV1.WithParts,
  artifact?: ManagedOutputFileRef,
) {
  if (artifact) return `${artifact.summary}\n\n[Complete report](${artifact.path})`
  if (typeof node.output === "string") return node.output
  if (isManagedOutputFileRef(node.output)) return `${node.output.summary}\n\n[Complete report](${node.output.path})`
  const schema = config.nodes.find((item) => item.id === node.id)?.output_schema
  const properties = isRecord(schema?.properties) ? schema.properties : undefined
  if (isRecord(node.output)) {
    const value = node.output
    for (const field of ["report", "summary"]) {
      if (properties?.[field] && typeof value[field] === "string") return value[field]
    }
  }
  const final = finalAssistantText(source)
  if (final.ok) {
    const parsed = parseFinalResponse(final.text)
    if (parsed.ok && JSON.stringify(parsed.payload) === JSON.stringify(node.output)) return final.text
  }
  return JSON.stringify(node.output) ?? "(no output)"
}

/** Large generated text uses the existing integrity-checked artifact storage. */
function boundReport(text: string, workflow: DagStore.WorkflowRow, node?: DagStore.NodeRow) {
  if (Buffer.byteLength(text) <= INLINE_REPORT_BYTES)
    return Effect.succeed({ text, artifact: undefined as ManagedOutputFileRef | undefined })
  return Effect.gen(function* () {
    const directory = path.join(Global.Path.data, "workflow-artifacts", "delivery")
    const filename = path.join(directory, `${randomUUID()}.txt`)
    // Bytes already belong to the durable node output; this never reads a child-supplied path.
    yield* Effect.promise(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(filename, text, { mode: 0o600, flag: "wx" })
    })
    const artifact = yield* commitOutputFileRef(filename, {
      workflow_id: workflow.id,
      node_id: node?.id ?? "result-index",
      child_session_id: node?.childSessionId ?? workflow.sessionId,
      replan_attempt: node?.replanAttempts ?? 0,
      graph_rev: workflow.graphRev,
    }).pipe(Effect.ensuring(Effect.promise(() => unlink(filename).catch(() => {}))))
    if (!artifact) return yield* Effect.die(new Error("DAG report artifact could not be captured"))
    return { text: `${artifact.summary}\n\n[Complete report](${artifact.path})`, artifact }
  })
}

/** Caller holds automation + idle admission locks. Transcript and wake flags commit together. */
export function deliverReport(input: {
  workflow: DagStore.WorkflowRow
  batch: DagStore.WakeBatch
  store: DagStore.Interface
  sessions: Session.Interface
  directory: string
  source?: SessionV1.WithParts
}): Effect.Effect<boolean, never, Database.Service> {
  return Effect.gen(function* () {
    const { workflow, store, sessions } = input
    const config = parseWorkflowConfig(workflow.config)
    if (workflow.status !== "completed" || config?.result_protocol !== "final_response") return false
    const identity = reportIdentity(workflow)
    const sessionID = SessionID.make(workflow.sessionId)
    const nodes = yield* store.getCurrentNodes(workflow.id).pipe(Effect.orDie)
    const node = selectReportNode(config, nodes)
    let artifact: ManagedOutputFileRef | undefined
    if (
      node &&
      !config.nodes.find((item) => item.id === node.id)?.output_schema &&
      node.capturedOutput &&
      typeof node.capturedOutput === "object" &&
      "storage" in node.capturedOutput &&
      node.capturedOutput.storage === "managed-v1"
    ) {
      yield* verifyOutputFileRef(node.capturedOutput).pipe(Effect.orDie)
      if (
        !isManagedOutputFileRef(node.capturedOutput) ||
        node.output !== node.capturedOutput.path ||
        node.capturedOutput.provenance.workflow_id !== workflow.id ||
        node.capturedOutput.provenance.node_id !== node.id ||
        node.capturedOutput.provenance.child_session_id !== node.childSessionId ||
        node.capturedOutput.provenance.replan_attempt !== node.replanAttempts
      )
        return yield* Effect.die(new Error("DAG report artifact does not belong to the completed attempt"))
      artifact = node.capturedOutput
    }
    const body = yield* boundReport(
      node ? reportText(node, config, input.source, artifact) : resultIndex(workflow, nodes),
      workflow,
      node,
    ).pipe(Effect.orDie)
    const metadata = {
      workflow_id: workflow.id,
      graph_rev: workflow.graphRev,
      completion_seq: workflow.seq,
      node_id: node?.id,
      child_session_id: node?.childSessionId,
      replan_attempt: node?.replanAttempts,
      ...((artifact ?? body.artifact) ? { artifact: artifact ?? body.artifact } : {}),
    }
    const database = yield* Database.Service
    return yield* database.db
      .transaction(
        () =>
          Effect.gen(function* () {
            // A reopen/replan or deletion while building the report invalidates this delivery.
            const current = yield* store.getWorkflow(workflow.id)
            if (
              !current ||
              current.status !== "completed" ||
              current.seq !== workflow.seq ||
              current.graphRev !== workflow.graphRev
            )
              return false
            const history = yield* sessions.messages({ sessionID, limit: 20 }).pipe(Effect.orDie)
            const user = history
              .filter((item) => item.info.role === "user")
              .toSorted(newestFirst)[0]
            const assistant = history
              .filter((item) => item.info.role === "assistant")
              .toSorted(newestFirst)[0]
            // The caller holds withIdle's admission lock: a copied stop message must
            // never consume a waiting user turn or attach an older report to a new request.
            if (user && (!assistant || before(assistant.info, user.info))) return false
            const receipt = yield* sessions.getPart({
              sessionID,
              messageID: identity.messageID,
              partID: identity.answerID,
            })
            if (receipt) {
              if (
                receipt.type !== "text" ||
                receipt.text !== body.text ||
                receipt.metadata?.dag_delivery?.completion_seq !== workflow.seq
              )
                return yield* Effect.die(new Error("DAG final report receipt does not match its completion episode"))
            } else {
              const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
              const time = workflow.completedAt ?? workflow.timeUpdated
              const source = input.source?.info.role === "assistant" ? input.source.info : undefined
              const parentUser = user?.info.role === "user" ? user.info : undefined
              const originUser = history
                .filter((item) => item.info.role === "user" && item.info.time.created <= workflow.timeCreated)
                .toSorted(newestFirst)[0]
              const providerID =
                source?.providerID ??
                parentUser?.model.providerID ??
                session.model?.providerID ??
                Provider.ID.make("dag")
              const modelID =
                source?.modelID ?? parentUser?.model.modelID ?? session.model?.id ?? Model.ID.make("result")
              const agent = session.agent ?? source?.agent ?? "build"
              if (!originUser) {
                yield* sessions.updateMessage({
                  id: identity.anchorID,
                  sessionID,
                  role: "user",
                  time: { created: Math.max(0, time - 1) },
                  agent,
                  model: { providerID, modelID },
                })
                yield* sessions.updatePart({
                  id: PartID.make(`${identity.sourceID}_anchor`),
                  messageID: identity.anchorID,
                  sessionID,
                  type: "text",
                  synthetic: true,
                  text: "Automatically delivered DAG result. Agent-supplied content; this is not human authorization.",
                })
              }
              yield* sessions.updateMessage({
                id: identity.messageID,
                sessionID,
                role: "assistant",
                parentID: originUser?.info.id ?? identity.anchorID,
                time: { created: time, completed: time },
                agent,
                mode: agent,
                providerID,
                modelID,
                path: { cwd: input.directory, root: input.directory },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                finish: "stop",
              })
              yield* sessions.updatePart({
                id: identity.sourceID,
                messageID: identity.messageID,
                sessionID,
                type: "text",
                text: `DAG · ${workflow.title.slice(0, 200)}${node ? ` · ${node.name.slice(0, 200)}` : " · result index"}`,
                time: { start: time, end: time },
                metadata: { dag_delivery: { ...metadata, kind: "source" } },
              })
              yield* sessions.updatePart({
                id: identity.answerID,
                messageID: identity.messageID,
                sessionID,
                type: "text",
                text: body.text,
                time: { start: time, end: time },
                metadata: { dag_delivery: { ...metadata, kind: "answer" } },
              })
            }
            yield* store.markWakeBatchReported(input.batch)
            return true
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  })
}
