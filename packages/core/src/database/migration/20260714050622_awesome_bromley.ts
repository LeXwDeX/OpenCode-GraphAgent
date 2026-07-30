import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260714050622_awesome_bromley",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`deadline_ms\` integer;`)
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`wake_eligible\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`wake_reported\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`workflow_node\` ADD \`replan_attempts\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`workflow\` ADD \`wake_reported\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
