import { expect, mock, spyOn } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { createRequire } from "node:module"
import { Database, getTableColumns, getTableName } from "@opencode-ai/console-core/drizzle/index.js"
import { ZenData } from "@opencode-ai/console-core/model.js"
import { KeyTable } from "@opencode-ai/console-core/schema/key.sql.js"
import { WorkspaceTable } from "@opencode-ai/console-core/schema/workspace.sql.js"
import { UserTable } from "@opencode-ai/console-core/schema/user.sql.js"
import { BillingTable, LiteTable, SubscriptionTable } from "@opencode-ai/console-core/schema/billing.sql.js"
import { ModelTable } from "@opencode-ai/console-core/schema/model.sql.js"
import { ProviderTable } from "@opencode-ai/console-core/schema/provider.sql.js"
import * as keyLimiter from "../src/routes/zen/util/keyRateLimiter"
import { logger } from "../src/routes/zen/util/logger"
import type { APIEvent } from "@solidjs/start/server"

const require = createRequire(import.meta.resolve("@opencode-ai/console-core/drizzle/index.js"))
const { Client } = require("@planetscale/database")
const { drizzle } = require("drizzle-orm/planetscale-serverless")

async function runInferenceBoundary() {
  await mock.module("@opencode-ai/console-resource", () => ({
    Resource: { App: { stage: "test" }, ZEN_LITE_PRICE: {}, ZEN_BLACK_PRICE: {} },
  }))
  const { handler } = await import("../src/routes/zen/util/handler")
  const sqlite = new SQLite(":memory:")
  for (const table of [
    KeyTable,
    WorkspaceTable,
    UserTable,
    BillingTable,
    LiteTable,
    SubscriptionTable,
    ModelTable,
    ProviderTable,
  ]) {
    const columns = Object.values(getTableColumns(table))
      .map((column) => `\`${column.name}\``)
      .join(",")
    sqlite.run(`CREATE TABLE \`${getTableName(table)}\` (${columns})`)
  }
  sqlite.run("INSERT INTO `key` (id,workspace_id,user_id,`key`) VALUES ('key','own','member','synthetic-caller-key')")
  sqlite.run("INSERT INTO workspace (id) VALUES ('own')")
  sqlite.run("INSERT INTO user (id,workspace_id) VALUES ('member','own')")
  sqlite.run("INSERT INTO billing (id,workspace_id,balance) VALUES ('billing','own',100)")
  sqlite.run(
    "INSERT INTO provider (id,workspace_id,provider,credentials) VALUES ('provider','own','anthropic','synthetic-upstream-key')",
  )
  const client = new Client({ host: "fixture.invalid", username: "synthetic", password: "synthetic" })
  // Dynamic dependency loading and PlanetScale generic row overloads meet only at this fixture boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  client.execute = (async (sql: string, params: unknown[]) => ({
    rows: sqlite.query(sql).values(...(params as any[])),
    rowsAffected: 0,
    insertId: "0",
  })) as any
  const db = drizzle({ client })
  const use = spyOn(Database, "use").mockImplementation(async (callback) => callback(db))
  // The fixture defines only fields read by this inference path; production data includes additional catalog metadata.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const models = spyOn(ZenData, "list").mockReturnValue({
    models: {
      fixture: {
        name: "fixture",
        byokProvider: "anthropic",
        cost: { input: 1, output: 1 },
        providers: [{ id: "anthropic", model: "claude-haiku", priority: 0, weight: 1 }],
      },
    },
    providers: { anthropic: { api: "https://fixture.invalid", apiKey: "platform-key", format: "anthropic" } },
  } as any)
  const limiter = spyOn(keyLimiter, "createRateLimiter").mockReturnValue(undefined)
  const metric = spyOn(logger, "metric").mockImplementation(() => {})
  const debug = spyOn(logger, "debug").mockImplementation(() => {})
  const upstream: Headers[] = []
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        upstream.push(new Headers(init?.headers))
        return Response.json({ content: [] })
      },
      { preconnect() {} },
    ),
  )
  const call = () =>
    handler(
      {
        request: new Request("https://fixture.invalid/zen/v1/messages", {
          method: "POST",
          headers: {
            Authorization: "Bearer synthetic-caller-key",
            Cookie: "session=synthetic-cookie",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ messages: [] }),
        }),
      } as APIEvent,
      {
        format: "anthropic",
        modelList: "full",
        parseApiKey: () => "synthetic-caller-key",
        parseModel: () => "fixture",
        parseVariant: () => undefined,
        parseIsStream: () => false,
      },
    )
  try {
    for (const table of ["user", "workspace"]) {
      sqlite.run(`UPDATE ${table} SET time_deleted='2026-10-05'`)
      expect((await call()).status).toBe(401)
      expect(upstream).toHaveLength(0)
      sqlite.run(`UPDATE ${table} SET time_deleted=NULL`)
    }
    expect((await call()).status).toBe(200)
    expect(upstream).toHaveLength(1)
    expect(upstream[0].get("x-api-key")).toBe("synthetic-upstream-key")
    expect(upstream[0].get("authorization")).toBeNull()
    expect(upstream[0].get("cookie")).toBeNull()
    expect(upstream[0].get("anthropic-version")).toBe("2023-06-01")
  } finally {
    fetch.mockRestore()
    debug.mockRestore()
    metric.mockRestore()
    limiter.mockRestore()
    models.mockRestore()
    use.mockRestore()
    sqlite.close()
  }
}

await runInferenceBoundary()
