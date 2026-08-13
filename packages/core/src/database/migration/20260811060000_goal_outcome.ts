import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811060000_goal_outcome",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE goal_outcome (
          goal_id text PRIMARY KEY,
          session_id text NOT NULL,
          payload text NOT NULL,
          completed_at integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX goal_outcome_session_completed_idx ON goal_outcome (session_id, completed_at);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
