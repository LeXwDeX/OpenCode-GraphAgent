import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260715035022_captured_output",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`captured_output\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
