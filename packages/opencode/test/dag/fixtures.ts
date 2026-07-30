import type { DagStore } from "@opencode-ai/core/dag/store"

export function makeNodeRow(overrides: Partial<DagStore.NodeRow> = {}): DagStore.NodeRow {
  return {
    id: "node-1",
    workflowId: "wf-1",
    name: "Test Node",
    workerType: "build",
    status: "pending",
    required: true,
    dependsOn: [],
    modelId: null,
    modelProviderId: null,
    childSessionId: null,
    output: undefined,
    capturedOutput: undefined,
    errorReason: null,
    deadlineMs: null,
    wakeEligible: false,
    wakeReported: false,
    replanAttempts: 0,
    seq: 0,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}
