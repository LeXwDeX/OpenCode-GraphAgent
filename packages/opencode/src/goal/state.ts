export * as GoalState from "./state"

import { Effect, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/schema/schema"

export const Status = Schema.Literals(["active", "paused", "done"])
export type Status = Schema.Schema.Type<typeof Status>

// `skipped` was a dead enum value with no production write path — removed.
export const Verdict = Schema.Literals(["done", "continue"])
export type Verdict = Schema.Schema.Type<typeof Verdict>

export class Info extends Schema.Class<Info>("GoalState")({
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
export const nni = (value: number): Schema.Schema.Type<typeof NonNegativeInt> =>
  value as Schema.Schema.Type<typeof NonNegativeInt>
