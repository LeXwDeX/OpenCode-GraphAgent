// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003000100_dag_capture_presence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE workflow_node ADD captured_output_present integer NOT NULL DEFAULT 0")
      yield* tx.run("ALTER TABLE workflow_node ADD captured_snapshot_id text")
      // JSON null is stored as text `null`; SQL NULL is the legacy empty slot.
      yield* tx.run("UPDATE workflow_node SET captured_output_present = 1 WHERE captured_output IS NOT NULL")
    })
  },
} satisfies DatabaseMigration.Migration
