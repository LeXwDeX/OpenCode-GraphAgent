// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Rev-view (v1.0.15 Train A, workflows/dag-engine-optimization.md). Legacy
// policy: existing rows migrate in place with superseded=false / graph_rev=1,
// so every pre-feature workflow renders EXACTLY as before — including its
// cancelled-via-replan rows, which stay visible and counted (config
// membership cannot be the current-rev predicate: <=v1.0.14 merged configs
// already drop cancelled nodes, so it would hide rows that render today).
// Marking only ever happens via the WorkflowReplanned and NodeCancelled
// projections after this migration runs.
export default {
  id: "20260815044858_dag_graph_rev_view",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`superseded\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`workflow\` ADD \`graph_rev\` integer DEFAULT 1 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
