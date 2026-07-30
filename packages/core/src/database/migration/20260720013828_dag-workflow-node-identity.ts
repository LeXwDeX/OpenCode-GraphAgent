import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260720013828_dag-workflow-node-identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_workflow_node\` (
          \`id\` text NOT NULL,
          \`workflow_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`worker_type\` text NOT NULL,
          \`status\` text NOT NULL,
          \`required\` integer DEFAULT true NOT NULL,
          \`depends_on\` text NOT NULL,
          \`model_id\` text,
          \`model_provider_id\` text,
          \`child_session_id\` text,
          \`output\` text,
          \`error_reason\` text,
          \`captured_output\` text,
          \`deadline_ms\` integer,
          \`wake_eligible\` integer DEFAULT false NOT NULL,
          \`wake_reported\` integer DEFAULT false NOT NULL,
          \`replan_attempts\` integer DEFAULT 0 NOT NULL,
          \`seq\` integer NOT NULL,
          \`started_at\` integer,
          \`completed_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`workflow_node_pk\` PRIMARY KEY(\`workflow_id\`, \`id\`),
          CONSTRAINT \`fk_workflow_node_workflow_id_workflow_id_fk\` FOREIGN KEY (\`workflow_id\`) REFERENCES \`workflow\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_workflow_node\`(\`id\`, \`workflow_id\`, \`name\`, \`worker_type\`, \`status\`, \`required\`, \`depends_on\`, \`model_id\`, \`model_provider_id\`, \`child_session_id\`, \`output\`, \`error_reason\`, \`captured_output\`, \`deadline_ms\`, \`wake_eligible\`, \`wake_reported\`, \`replan_attempts\`, \`seq\`, \`started_at\`, \`completed_at\`, \`time_created\`, \`time_updated\`) SELECT \`id\`, \`workflow_id\`, \`name\`, \`worker_type\`, \`status\`, \`required\`, \`depends_on\`, \`model_id\`, \`model_provider_id\`, \`child_session_id\`, \`output\`, \`error_reason\`, \`captured_output\`, \`deadline_ms\`, \`wake_eligible\`, \`wake_reported\`, \`replan_attempts\`, \`seq\`, \`started_at\`, \`completed_at\`, \`time_created\`, \`time_updated\` FROM \`workflow_node\`;`,
      )
      yield* tx.run(`DROP TABLE \`workflow_node\`;`)
      yield* tx.run(`ALTER TABLE \`__new_workflow_node\` RENAME TO \`workflow_node\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`CREATE INDEX \`workflow_node_workflow_idx\` ON \`workflow_node\` (\`workflow_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`workflow_node_workflow_status_idx\` ON \`workflow_node\` (\`workflow_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`workflow_node_workflow_id_seq_idx\` ON \`workflow_node\` (\`workflow_id\`,\`id\`,\`seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
