import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const GoalStateTable = sqliteTable(
  "goal_state",
  {
    session_id: text().primaryKey(),
    payload: text().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [index("goal_state_updated_at_idx").on(t.updated_at)],
)
