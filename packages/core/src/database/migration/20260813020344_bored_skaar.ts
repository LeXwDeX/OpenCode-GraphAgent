import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813020344_bored_skaar",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`session_directory_idx\` ON \`session\` (\`directory\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
