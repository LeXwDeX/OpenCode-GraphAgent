import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261002233822_dag_result_nudge",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`agent_mailbox\` ADD \`result_nudge_revision\` integer DEFAULT -1 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
