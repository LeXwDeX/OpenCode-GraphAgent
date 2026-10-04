import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Client } from "@planetscale/database"
import { drizzle } from "drizzle-orm/planetscale-serverless"
import { Database } from "../src/drizzle"
import { Actor } from "../src/actor"
import { User } from "../src/user"
import { Provider } from "../src/provider"

let keys: { user: string; workspace: string; deleted: boolean }[]
let users: { id: string; workspace: string; deleted: boolean }[]
let failUser = false
const queries: string[] = []
const client = new Client({ host: "fixture.invalid", username: "synthetic", password: "synthetic" })
// PlanetScale overloads permit arbitrary caller row types; this fixture returns Drizzle array rows.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
client.execute = (async (sql: string, params: unknown[]) => {
  queries.push(sql)
  if (sql.startsWith("select ")) {
    return {
      rows: [
        ["provider", "anthropic", "synthetic-provider-secret-with-32-characters"],
        ["short", "google", "tiny"],
      ],
      rowsAffected: 2,
    }
  }
  if (sql.startsWith("update `key`")) {
    for (const row of keys) if (row.user === params[0] && row.workspace === params[1]) row.deleted = true
  } else if (sql.startsWith("update `user`")) {
    if (failUser) throw new Error("Synthetic member update failure")
    for (const row of users) if (row.id === params[0] && row.workspace === params[1]) row.deleted = true
  } else throw new Error("Unexpected SQL")
  return { rows: [], rowsAffected: 1 }
}) as any
const db = drizzle({ client })

beforeEach(() => {
  keys = [
    { user: "member", workspace: "own", deleted: false },
    { user: "member", workspace: "other", deleted: false },
    { user: "neighbor", workspace: "own", deleted: false },
  ]
  users = [{ id: "member", workspace: "own", deleted: false }]
  failUser = false
  queries.length = 0
})
let restore = () => {}
beforeEach(() => {
  const use = spyOn(Database, "use").mockImplementation(async (callback) => callback(db))
  const transaction = spyOn(Database, "transaction").mockImplementation(async (callback) => {
    const snapshot = structuredClone({ keys, users })
    try {
      return await callback(db)
    } catch (error) {
      keys = snapshot.keys
      users = snapshot.users
      throw error
    }
  })
  restore = () => {
    use.mockRestore()
    transaction.mockRestore()
  }
})
afterEach(() => restore())
const asUser = <T>(role: "admin" | "member", fn: () => T) =>
  Actor.provide("user", { userID: "admin", workspaceID: "own", accountID: "account", role }, fn)

test("public provider query never includes raw secrets for members or admins", async () => {
  for (const role of ["admin", "member"] as const) {
    const providers = await asUser(role, () => Provider.list())
    expect(JSON.stringify(providers)).not.toContain("synthetic-provider-secret-with-32-characters")
    expect(JSON.stringify(providers)).not.toContain("tiny")
    expect(providers[1].credentialsDisplay).toBe("********")
    expect(providers.every((x) => !("credentials" in x))).toBe(true)
  }
})

test("member removal revokes only that workspace member's keys in the same transaction", async () => {
  await asUser("admin", () => User.remove("member"))
  expect(keys.map((x) => x.deleted)).toEqual([true, false, false])
  expect(users[0].deleted).toBe(true)
  expect(queries).toHaveLength(2)
})

test("failed member removal rolls back key revocation", async () => {
  failUser = true
  expect(String(await asUser("admin", () => User.remove("member")).catch((error: unknown) => error))).toContain(
    "Failed query",
  )
  expect(keys.every((x) => !x.deleted)).toBe(true)
  expect(users[0].deleted).toBe(false)
})
