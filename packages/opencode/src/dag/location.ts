export * as DagLocation from "./location"

/**
 * DAG-LOC-01 — the execution-location authority.
 *
 * The DAG runtime (DagLoop, GoalLoop) is per-directory InstanceState, but the
 * durable store, the event bus, and the workflow rows are process-global. A
 * multi-directory server (sibling worktrees of ONE project — same project id)
 * would otherwise let every instance adopt, recover-cancel, wake, and spawn
 * for every workflow. This module is the SINGLE authority that decides which
 * instance may act: the location key is the DIRECTORY, not the project id.
 *
 * The key lives on the workflow row itself (WorkflowTable.directory), stamped
 * at dag.create from the creating instance's directory. Ownership predicates
 * re-read the durable row on every check, so a row whose durable identity was
 * repainted (identity migration) or deleted stops matching and its in-memory
 * runtime entry loses the right to publish transitions.
 *
 * Callers (the loops) pass their own instance directory and know nothing about
 * the SQL or the realpath internals. The Database service is resolved lazily
 * via serviceOption so the loops' static requirements stay unchanged (the
 * optional-cross-dependency pattern); production graphs always carry it.
 */

import { eq } from "drizzle-orm"
import { realpathSync } from "node:fs"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowTable } from "@opencode-ai/core/dag/sql"
import { InstanceRef } from "@/effect/instance-ref"

/**
 * Canonical execution-location key: the directory's realpath when resolvable,
 * else the raw path (test directories like /wtA do not exist on disk; the
 * fallback keeps the comparison a plain string equality in that case). Both
 * stamping (dag.create) and checking go through this, so the two sides are
 * always comparable under the same normalization.
 */
export const canonicalDirectory = (directory: string): string => {
  try {
    return realpathSync(directory)
  } catch {
    return directory
  }
}

/** The directory to stamp on a workflow created by the ambient instance. */
export const stampDirectory = (): Effect.Effect<string> =>
  Effect.map(InstanceRef, (instance) => (instance ? canonicalDirectory(instance.directory) : ""))

/**
 * Owns the workflow iff its DURABLE row (re-read on every check) still belongs
 * to the ambient instance: the project id matches (fast-reject + R6 identity
 * revalidation — a repainted project_id must not keep driving the old entry)
 * and the stamped directory matches the caller's directory (the deciding
 * guard: sibling worktrees share the project id). Fail-closed: a missing
 * instance or a row without a stamp is never adopted.
 */
export const ownsWorkflow = (workflowID: string, directory: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const instance = yield* InstanceRef
    if (!instance) return false
    const db = yield* Effect.serviceOption(Database.Service)
    if (db._tag === "None") return false
    const row = yield* db.value.db
      .select()
      .from(WorkflowTable)
      .where(eq(WorkflowTable.id, workflowID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return false
    if (row.project_id !== instance.project.id) return false
    return row.directory !== null && canonicalDirectory(row.directory) === canonicalDirectory(directory)
  })

/**
 * Owns the session iff every durable workflow row of the session still belongs
 * to the ambient instance (same project id + directory conjunct as
 * ownsWorkflow). Vacuous-true when the session has no workflow rows: there is
 * no wake data to deliver and goal-only sessions predate workflow stamping.
 * Also vacuous-true when the Database service is absent from the runtime graph
 * (synthetic goal tests; every production graph carries it) — ownership cannot
 * be disproven there and the gate must not silently disable pre-existing
 * loops. The workflow-row key keeps this module free of session-table reads:
 * the execution-location key belongs on the workflow row itself (R7).
 */
export const ownsSession = (sessionID: string, directory: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const instance = yield* InstanceRef
    if (!instance) return false
    const db = yield* Effect.serviceOption(Database.Service)
    if (db._tag === "None") return true
    const rows = yield* db.value.db
      .select()
      .from(WorkflowTable)
      .where(eq(WorkflowTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    return rows.every(
      (row) =>
        row.project_id === instance.project.id &&
        row.directory !== null &&
        canonicalDirectory(row.directory) === canonicalDirectory(directory),
    )
  })
