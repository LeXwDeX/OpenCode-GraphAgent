import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813040429_workflow_directory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow\` ADD \`directory\` text;`)
      // DAG-LOC-01 backfill: the ownership key is the workflow row's own
      // directory, so existing installs must carry the owning session's
      // directory forward or every in-flight workflow would turn foreign
      // (never adopted / orphan-pending rows never terminalized). Rows whose
      // session is already gone stay NULL — conservative: NULL matches no
      // instance directory and is never adopted.
      yield* tx.run(`
        UPDATE \`workflow\`
        SET \`directory\` = (
          SELECT \`directory\` FROM \`session\` WHERE \`session\`.\`id\` = \`workflow\`.\`session_id\`
        )
        WHERE \`directory\` IS NULL;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
