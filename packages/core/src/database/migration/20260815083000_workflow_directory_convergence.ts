import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815083000_workflow_directory_convergence",
  up(tx) {
    return Effect.gen(function* () {
      // #269 atomic-adoption convergence (C6). The execution-location stamp now
      // moves WITH the session at SessionEvent.Moved time (session projector),
      // but installs that moved a session BEFORE that transition shipped carry
      // divergent stamps: the session row points at the destination directory
      // while its pre-move workflow rows stay pinned at the old one. With the
      // fail-closed ownership conjunct, those mixed stamps leave the session's
      // wakes with NO owner (the wedge from v1.0.13). Converge every NON-NULL
      // workflow stamp to its session's CURRENT directory — the same direction
      // the live Moved re-stamp moves it. No ALTER: the directory column already
      // exists. Preserves the fail-closed invariants: a NULL stamp (legacy row
      // never backfilled) stays NULL, and a workflow whose session has no
      // directory is left untouched. Idempotent — re-running converges to the
      // same state.
      yield* tx.run(`
        UPDATE \`workflow\`
        SET \`directory\` = (
          SELECT \`directory\` FROM \`session\` WHERE \`session\`.\`id\` = \`workflow\`.\`session_id\`
        )
        WHERE \`workflow\`.\`directory\` IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM \`session\`
            WHERE \`session\`.\`id\` = \`workflow\`.\`session_id\`
              AND \`session\`.\`directory\` IS NOT NULL
          );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
