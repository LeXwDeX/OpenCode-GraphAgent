import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803073521_workflow_node_error_class",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`error_class\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
