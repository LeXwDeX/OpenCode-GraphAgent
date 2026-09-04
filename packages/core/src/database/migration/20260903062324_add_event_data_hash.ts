import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260903062324_add_event_data_hash",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`event\` ADD \`data_hash\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
