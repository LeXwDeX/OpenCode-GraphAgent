export * as GoalState from "./state"

import { Effect, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/schema/schema"

export const Status = Schema.Literals(["active", "paused", "done"])
export type Status = Schema.Schema.Type<typeof Status>

// `skipped` was a dead enum value with no production write path — removed.
export const Verdict = Schema.Literals(["done", "continue", "blocked"])
export type Verdict = Schema.Schema.Type<typeof Verdict>

export class Info extends Schema.Class<Info>("GoalState")({
  goal_id: Schema.String.pipe(
    Schema.optional,
    Schema.withDecodingDefault(Effect.succeed("legacy")),
  ),
  revision: NonNegativeInt.pipe(
    Schema.optional,
    Schema.withDecodingDefault(Effect.succeed(0 as Schema.Schema.Type<typeof NonNegativeInt>)),
  ),
  goal: Schema.String,
  status: Status,
  turns_used: NonNegativeInt,
  max_turns: NonNegativeInt,
  created_at: Schema.Number,
  last_turn_at: Schema.Number,
  last_verdict: Schema.optional(Verdict),
  last_reason: Schema.optional(Schema.String),
  paused_reason: Schema.optional(Schema.String),
  consecutive_parse_failures: NonNegativeInt,
  subgoals: Schema.Array(Schema.String).pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<string>))),
}) {}

/**
 * Construct a goal NonNegativeInt field from a plain number, centralizing the
 * one unavoidable cast. Every call site computes these from validated
 * arithmetic (0, prev+1, clamped parse-failure counters) so the runtime ≥0
 * filter is redundant here; this keeps the escape hatch at a single audited
 * site instead of `as any` scattered across goal.ts.
 */
export const nni = (value: number): Schema.Schema.Type<typeof NonNegativeInt> => value

export function advance(state: Info, patch: Partial<Omit<Info, "revision">>) {
  return new Info({
    goal_id: state.goal_id,
    revision: nni((state.revision ?? 0) + 1),
    goal: state.goal,
    status: state.status,
    turns_used: state.turns_used,
    max_turns: state.max_turns,
    created_at: state.created_at,
    last_turn_at: state.last_turn_at,
    last_verdict: state.last_verdict,
    last_reason: state.last_reason,
    paused_reason: state.paused_reason,
    consecutive_parse_failures: state.consecutive_parse_failures,
    subgoals: state.subgoals,
    ...patch,
  })
}
