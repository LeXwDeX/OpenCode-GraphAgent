import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260702000000_dag_workflow_tables",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`workflow\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`status\` text NOT NULL,
          \`config\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`started_at\` integer,
          \`completed_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`workflow_project_idx\` ON \`workflow\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`workflow_session_idx\` ON \`workflow\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`workflow_status_idx\` ON \`workflow\` (\`status\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS \`workflow_id_seq_idx\` ON \`workflow\` (\`id\`, \`seq\`);`)

      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`workflow_node\` (
          \`id\` text PRIMARY KEY,
          \`workflow_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`worker_type\` text NOT NULL,
          \`status\` text NOT NULL,
          \`required\` integer NOT NULL DEFAULT 1,
          \`depends_on\` text NOT NULL,
          \`model_id\` text,
          \`model_provider_id\` text,
          \`child_session_id\` text,
          \`output\` text,
          \`error_reason\` text,
          \`retry_count\` integer NOT NULL DEFAULT 0,
          \`seq\` integer NOT NULL,
          \`started_at\` integer,
          \`completed_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          FOREIGN KEY (\`workflow_id\`) REFERENCES \`workflow\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`workflow_node_workflow_idx\` ON \`workflow_node\` (\`workflow_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`workflow_node_workflow_status_idx\` ON \`workflow_node\` (\`workflow_id\`, \`status\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS \`workflow_node_workflow_id_seq_idx\` ON \`workflow_node\` (\`workflow_id\`, \`id\`, \`seq\`);`)

      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`workflow_violation\` (
          \`id\` text PRIMARY KEY,
          \`workflow_id\` text NOT NULL,
          \`node_id\` text,
          \`type\` text NOT NULL,
          \`severity\` text NOT NULL,
          \`message\` text NOT NULL,
          \`details\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          FOREIGN KEY (\`workflow_id\`) REFERENCES \`workflow\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`workflow_violation_workflow_idx\` ON \`workflow_violation\` (\`workflow_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`workflow_violation_severity_idx\` ON \`workflow_violation\` (\`workflow_id\`, \`severity\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
