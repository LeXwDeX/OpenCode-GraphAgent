import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import Stripe from "stripe"

type Payment = { id: string; workspace_id: string; payment_id: string; time_deleted: string | null }
type Coupon = { email: string; type: string; time_redeemed: string | null }
type State = { coupons: Coupon[]; payments: Payment[]; balances: Record<string, number>; grants: number }
let state: State
let tail = Promise.resolve()
let failRedemption = false
const queries: { sql: string; params: unknown[]; transaction: boolean }[] = []

// Model the database boundary, retaining the real Drizzle SQL builders and
// Database's ambient transaction context. Transactions serialize and roll back;
// independent reads do not acquire a lock.
function connection(transaction: boolean) {
  return {
    execute: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params, transaction })
      const result = (rows: unknown[][] = []) => ({ rows, rowsAffected: 1, insertId: "0" })
      if (sql.startsWith("select ")) {
        const columns = sql.slice(7, sql.indexOf(" from ")).split(", ").map((x) => x.match(/`([^`]+)`$/)?.[1])
        if (sql.includes(" from `coupon`")) {
          const row = state.coupons.find((x) => x.email === params[0] && x.type === params[1])
          const values: Record<string, unknown> = row ?? {}
          return result(row ? [columns.map((key) => key ? values[key] : undefined)] : [])
        }
        if (sql.includes(" from `payment`")) {
          const row = state.payments.find(
            (x) => x.workspace_id === params[0] && x.payment_id === params[1] && x.time_deleted === null,
          )
          const values: Record<string, unknown> = row ?? {}
          return result(row ? [columns.map((key) => key ? values[key] : undefined)] : [])
        }
      }
      if (sql.startsWith("update `billing`")) {
        state.balances[String(params[1])] = (state.balances[String(params[1])] ?? 0) + Number(params[0])
        return result()
      }
      if (sql.startsWith("insert into `payment`")) {
        state.grants++
        return result()
      }
      if (sql.startsWith("insert into `coupon`")) {
        if (failRedemption) throw new Error("Synthetic redemption write failure")
        const email = String(params[0])
        const type = String(params[1])
        const coupon = state.coupons.find((x) => x.email === email && x.type === type)
        if (coupon) coupon.time_redeemed = "2026-01-01 00:00:00.000"
        else state.coupons.push({ email, type, time_redeemed: "2026-01-01 00:00:00.000" })
        return result()
      }
      throw new Error(`Unexpected database query: ${sql}`)
    },
  }
}

class TestClient {
  execute = connection(false).execute
  async transaction<T>(callback: (tx: ReturnType<typeof connection>) => Promise<T>) {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    const snapshot = structuredClone(state)
    try {
      return await callback(connection(true))
    } catch (error) {
      state = snapshot
      throw error
    } finally {
      release()
    }
  }
}

await mock.module("@planetscale/database", () => ({ Client: TestClient }))
await mock.module("@opencode-ai/console-resource", () => ({
  Resource: { Database: { host: "example.invalid", username: "synthetic", password: "synthetic" }, ZEN_LITE_PRICE: {} },
}))
const { Actor } = await import("../src/actor")
const { Billing } = await import("../src/billing")

beforeEach(() => {
  state = {
    coupons: [{ email: "eligible@example.invalid", type: "BUILDATHON", time_redeemed: null }],
    payments: [
      { id: "pay_own", workspace_id: "wrk_a", payment_id: "pi_own", time_deleted: null },
      { id: "pay_other", workspace_id: "wrk_b", payment_id: "pi_other", time_deleted: null },
      { id: "pay_deleted", workspace_id: "wrk_a", payment_id: "pi_deleted", time_deleted: "2026-01-01" },
    ],
    balances: { wrk_a: 0, wrk_b: 0 },
    grants: 0,
  }
  tail = Promise.resolve()
  failRedemption = false
  queries.length = 0
})
afterEach(() => mock.restore())

const inWorkspace = <T>(workspaceID: string, fn: () => T) => Actor.provide("system", { workspaceID }, fn)

describe("receipt ownership", () => {
  test("unknown, deleted and other-workspace payments are rejected before contacting Stripe", async () => {
    const stripe = spyOn(Billing, "stripe").mockImplementation(() => { throw new Error("Stripe must not be called") })
    for (const paymentID of ["pi_other", "pi_deleted", "pi_missing"]) {
      await expect(Promise.resolve(inWorkspace("wrk_a", () => Billing.generateReceiptUrl({ paymentID })))).rejects.toThrow("Payment not found")
    }
    expect(stripe).not.toHaveBeenCalled()
    expect(queries.every((query) => query.sql.includes("`workspace_id` = ?") && query.sql.includes("`time_deleted` is null"))).toBe(true)
  })

  test("the owner can obtain the receipt", async () => {
    const requests: string[] = []
    const client = new Stripe("sk_test_synthetic", {
      httpClient: Stripe.createFetchHttpClient(async (input: RequestInfo | URL) => {
        const url = String(input)
        requests.push(url)
        return Response.json(url.includes("payment_intents") ? { latest_charge: "ch_own" } : { receipt_url: "https://example.invalid/receipt" })
      }),
    })
    spyOn(Billing, "stripe").mockReturnValue(client)
    expect(await Promise.resolve(inWorkspace("wrk_a", () => Billing.generateReceiptUrl({ paymentID: "pi_own" })))).toBe("https://example.invalid/receipt")
    expect(requests.some((url) => url.endsWith("/payment_intents/pi_own"))).toBe(true)
    expect(requests.some((url) => url.endsWith("/charges/ch_own"))).toBe(true)
  })
})

describe("coupon redemption", () => {
  test("parallel redemption across workspaces grants credit once", async () => {
    const results = await Promise.allSettled([
      inWorkspace("wrk_a", () => Billing.redeemCoupon("eligible@example.invalid", "BUILDATHON")),
      inWorkspace("wrk_b", () => Billing.redeemCoupon("eligible@example.invalid", "BUILDATHON")),
    ])
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((x) => x.status === "rejected")).toHaveLength(1)
    expect(state.grants).toBe(1)
    expect(state.balances.wrk_a + state.balances.wrk_b).toBe(50_000_000_000)
    const reads = queries.filter((x) => x.sql.includes(" from `coupon`"))
    expect(reads).toHaveLength(2)
    expect(reads.every((x) => x.transaction && x.sql.endsWith(" for update"))).toBe(true)
  })

  test("a redemption write failure rolls back credit and permits a later retry", async () => {
    failRedemption = true
    await expect(Promise.resolve(inWorkspace("wrk_a", () => Billing.redeemCoupon("eligible@example.invalid", "BUILDATHON")))).rejects.toThrow()
    expect(state.grants).toBe(0)
    expect(state.balances.wrk_a).toBe(0)
    expect(state.coupons[0].time_redeemed).toBeNull()
    failRedemption = false
    await Promise.resolve(inWorkspace("wrk_b", () => Billing.redeemCoupon("eligible@example.invalid", "BUILDATHON")))
    expect(state.grants).toBe(1)
    expect(state.balances.wrk_b).toBe(50_000_000_000)
  })

  test("ineligible and redeemed coupons grant no credit", async () => {
    await expect(Promise.resolve(inWorkspace("wrk_a", () => Billing.redeemCoupon("unknown@example.invalid", "BUILDATHON")))).rejects.toThrow("Invalid coupon code")
    state.coupons[0].time_redeemed = "2026-01-01 00:00:00.000"
    await expect(Promise.resolve(inWorkspace("wrk_a", () => Billing.redeemCoupon("eligible@example.invalid", "BUILDATHON")))).rejects.toThrow("Coupon already redeemed")
    expect(state.grants).toBe(0)
  })

  test("the public first-month discount retains its eligibility behavior", async () => {
    await Promise.resolve(inWorkspace("wrk_a", () => Billing.redeemCoupon("new@example.invalid", "GO1MONTH50")))
    expect(state.coupons.some((x) => x.email === "new@example.invalid" && x.type === "GO1MONTH50" && x.time_redeemed)).toBe(true)
    expect(state.grants).toBe(0)
  })
})
