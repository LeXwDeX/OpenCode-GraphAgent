import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260805094941_workflow_node_timeout_extensions",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`timeout_extensions\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
