import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260903044702_drop_session_summary_diffs",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` DROP COLUMN \`summary_diffs\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
