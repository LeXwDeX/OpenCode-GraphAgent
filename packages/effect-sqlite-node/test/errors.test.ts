import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { NodeSqliteClient } from "../src"

test("prepare errors remain typed for object and array rows", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* NodeSqliteClient.SqliteClient
      for (const text of ["SELECT * FROM nonexistent_table", "SELECT syntax error !!!"]) {
        const object = yield* sql.unsafe(text).pipe(Effect.flip)
        const array = yield* sql.unsafe(text).values.pipe(Effect.flip)
        expect(object._tag).toBe("SqlError")
        expect(array._tag).toBe("SqlError")
      }
      expect(yield* sql.unsafe("SELECT 1 AS value")).toEqual([{ value: 1 }])
      expect(yield* sql.unsafe("SELECT 2").values).toEqual([[2]])
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  )
  expect(result).toBeUndefined()
})

test("application transforms remain defects", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const sql = yield* NodeSqliteClient.SqliteClient
      return yield* sql.unsafe("SELECT 1 AS value")
    }).pipe(
      Effect.provide(
        NodeSqliteClient.layer({
          filename: ":memory:",
          transformResultNames: () => {
            throw new Error("application defect")
          },
        }),
      ),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("application defect")
})
