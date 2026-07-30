import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260717034735_fearless_cammi",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`goal_state_updated_at_idx\`;`)
      yield* tx.run(`DROP TABLE \`goal_state\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
