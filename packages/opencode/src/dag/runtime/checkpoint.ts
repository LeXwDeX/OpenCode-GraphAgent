// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Option, Schema } from "effect"
import type { DagStore } from "@opencode-ai/core/dag/store"
import type { WorkflowConfig } from "../dag"

const ReplanVerdict = Schema.Struct({ verdict: Schema.Literal("replan") })
const parseJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export interface ReplanCheckpoint {
  readonly id: string
  readonly seq: number
}

export function isReplanVerdict(output: unknown) {
  const value = typeof output === "string" ? Option.getOrElse(parseJsonOption(output), () => output) : output
  return Option.isSome(Schema.decodeUnknownOption(ReplanVerdict)(value))
}

export function latestReplanCheckpoint(
  config: WorkflowConfig | undefined,
  nodes: readonly DagStore.NodeRow[],
): ReplanCheckpoint | undefined {
  if (!config) return undefined
  const reporting = new Set(config.nodes.filter((node) => node.report_to_parent === true).map((node) => node.id))
  return nodes.reduce<ReplanCheckpoint | undefined>((latest, node) => {
    if (node.status !== "completed" || !reporting.has(node.id) || !isReplanVerdict(node.output)) return latest
    if (latest && latest.seq >= node.seq) return latest
    return { id: node.id, seq: node.seq }
  }, undefined)
}

export * as Checkpoint from "./checkpoint"
