import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Separate migration id from the timeout_extensions ALTER: the runner
// applies each migration at most once keyed by id, so a DB that already ran
// the timeout_extensions migration must still pick up this column.
export default {
  id: "20260805094942_workflow_node_escalation_pending",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`escalation_pending\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
