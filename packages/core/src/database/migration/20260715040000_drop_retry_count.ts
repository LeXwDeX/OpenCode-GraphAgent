import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260715040000_drop_retry_count",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_node\` DROP COLUMN \`retry_count\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
