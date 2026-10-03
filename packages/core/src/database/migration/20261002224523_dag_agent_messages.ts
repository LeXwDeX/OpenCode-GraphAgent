import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261002224523_dag_agent_messages",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`agent_input_snapshot\` (
          \`id\` text PRIMARY KEY,
          \`mailbox_id\` text NOT NULL,
          \`logical_turn_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`message_ids\` text NOT NULL,
          \`associated\` integer DEFAULT false NOT NULL,
          \`stop_reason\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`agent_mailbox\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`workflow_id\` text,
          \`node_id\` text,
          \`attempt_id\` text,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`closed_reason\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`agent_message\` (
          \`id\` text PRIMARY KEY,
          \`workflow_id\` text NOT NULL,
          \`sender_id\` text NOT NULL,
          \`recipient_id\` text NOT NULL,
          \`recipient_session_id\` text NOT NULL,
          \`sender\` text NOT NULL,
          \`recipient\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`request\` text NOT NULL,
          \`content\` text NOT NULL,
          \`reply_to\` text,
          \`recipient_sequence\` integer NOT NULL,
          \`accepted_revision\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`reason\` text,
          \`snapshot_id\` text,
          \`transcript_id\` text NOT NULL,
          \`part_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_delivered\` integer
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`agent_input_snapshot_turn_idx\` ON \`agent_input_snapshot\` (\`mailbox_id\`,\`logical_turn_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`agent_mailbox_session_idx\` ON \`agent_mailbox\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`agent_message_sender_key_idx\` ON \`agent_message\` (\`sender_id\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`agent_message_recipient_sequence_idx\` ON \`agent_message\` (\`recipient_id\`,\`recipient_sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`agent_message_recipient_state_idx\` ON \`agent_message\` (\`recipient_id\`,\`state\`,\`recipient_sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`agent_message_session_idx\` ON \`agent_message\` (\`recipient_session_id\`,\`state\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
