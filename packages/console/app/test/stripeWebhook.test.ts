import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { createRequire } from "node:module"
import type { APIEvent } from "@solidjs/start/server"

// The real Stripe verifier runs locally; all service and persistence calls are isolated.
const Stripe = createRequire(import.meta.resolve("@opencode-ai/console-core/billing.js"))("stripe")
const verifier = new Stripe("sk_test_offline").webhooks
const secret = "whsec_offline_test"
type Row = Record<string, any>
type Predicate = (row: Row) => boolean
type Table = Record<string, string>
const table = (name: string, columns: string[]) => Object.fromEntries([["name", name], ...columns.map((x) => [x, x])])
const BillingTable = table("billing", ["workspaceID", "customerID", "balance"])
const PaymentTable = table("payment", [
  "id",
  "workspaceID",
  "customerID",
  "paymentID",
  "invoiceID",
  "amount",
  "enrichment",
  "timeRefunded",
])
const LiteTable = table("lite", ["workspaceID", "userID"])
let rows: Record<string, Row[]>
let failPaymentInsert = false
let failRefundBalance = false
let couponRedemptions = 0
let referralCalls = 0
let stripeInvoice: Row
let stripePaymentIntent: Row
let paymentIntentRequests: string[]
let invoiceRequests: string[]
let failReloadUpdate = false
let queue = Promise.resolve()
const actor = new AsyncLocalStorage<string>()

function database(transaction = false) {
  let staged: typeof rows | undefined
  let release: (() => void) | undefined
  const data = () => staged ?? rows
  const instance = {
    async lock() {
      if (release) return
      const previous = queue
      queue = new Promise<void>((resolve) => (release = resolve))
      await previous
      staged = structuredClone(rows)
    },
    finish(commit: boolean) {
      if (commit && staged) rows = staged
      release?.()
    },
    select(fields?: Record<string, string>) {
      let target: Table
      let predicate: Predicate = () => true
      let locked = false
      const query = {
        from(value: Table) {
          target = value
          return query
        },
        where(value: Predicate) {
          predicate = value
          return query
        },
        for(value: string) {
          expect(value).toBe("update")
          locked = true
          return query
        },
        // Drizzle queries are thenable; preserve that contract in this database double.
        // eslint-disable-next-line unicorn/no-thenable
        async then(resolve: (value: Row[]) => unknown, reject?: (error: unknown) => unknown) {
          try {
            if (locked && target.name === "billing") await instance.lock()
            if (transaction && target.name === "payment") {
              expect(staged).toBeDefined()
              expect(locked).toBe(true)
            }
            const matching = data()[target.name].filter(predicate)
            const result = matching.map((row) =>
              fields
                ? Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, row[column]]))
                : { ...row },
            )
            return resolve(result)
          } catch (error) {
            if (reject) return reject(error)
            throw error
          }
        },
      }
      return query
    },
    update(target: Table) {
      return {
        set(values: Row) {
          return {
            async where(predicate: Predicate) {
              expect(staged).toBeDefined()
              if (failReloadUpdate && target.name === "billing" && values.reload === false) {
                failReloadUpdate = false
                throw new Error("Injected reload write failure")
              }
              if (failRefundBalance && target.name === "billing" && values.balance?.parts?.[1]?.includes("-")) {
                failRefundBalance = false
                throw new Error("Injected refund write failure")
              }
              for (const row of data()[target.name].filter(predicate)) {
                for (const [key, value] of Object.entries(values)) {
                  row[key] = value?.parts
                    ? value.parts[0] === "now()"
                      ? new Date()
                      : row[value.values[0]] + (value.parts[1].includes("+") ? 1 : -1) * value.values[1]
                    : value
                }
              }
            },
          }
        },
      }
    },
    insert(target: Table) {
      return {
        async values(value: Row) {
          expect(staged).toBeDefined()
          if (target.name === "payment" && failPaymentInsert) {
            failPaymentInsert = false
            throw new Error("Injected payment write failure")
          }
          if (target.name === "lite" && data().lite.some((row) => row.userID === value.userID)) {
            throw new Error("Duplicate lite user")
          }
          data()[target.name].push({ ...value })
        },
      }
    },
  }
  return instance
}

const Database = {
  async use(callback: (tx: ReturnType<typeof database>) => Promise<unknown>) {
    return callback(database())
  },
  async transaction(callback: (tx: ReturnType<typeof database>) => Promise<unknown>) {
    const transaction = database(true)
    try {
      const result = await callback(transaction)
      transaction.finish(true)
      return result
    } catch (error) {
      transaction.finish(false)
      throw error
    }
  },
}

await mock.module("@opencode-ai/console-core/drizzle/index.js", () => ({
  Database,
  eq:
    (column: string, value: unknown): Predicate =>
    (row) =>
      row[column] === value,
  and:
    (...predicates: Predicate[]): Predicate =>
    (row) =>
      predicates.every((predicate) => predicate(row)),
  or:
    (...predicates: (Predicate | undefined)[]): Predicate =>
    (row) =>
      predicates.some((predicate) => predicate?.(row)),
  sql: (parts: TemplateStringsArray, ...values: unknown[]) => ({ parts: [...parts], values }),
}))
await mock.module("@opencode-ai/console-core/schema/billing.sql.js", () => ({ BillingTable, PaymentTable, LiteTable }))
await mock.module("@opencode-ai/console-core/actor.js", () => ({
  Actor: {
    provide: (_type: string, input: { workspaceID: string }, callback: () => unknown) =>
      actor.run(input.workspaceID, callback),
    workspace: () => actor.getStore(),
  },
}))
await mock.module("@opencode-ai/console-resource", () => ({ Resource: { STRIPE_WEBHOOK_SECRET: { value: secret } } }))
await mock.module("@opencode-ai/console-core/identifier.js", () => ({
  Identifier: { create: () => crypto.randomUUID() },
}))
await mock.module("@opencode-ai/console-core/lite.js", () => ({
  LiteData: { productID: () => "prod_lite", firstMonth50Coupon: "coupon50" },
}))
await mock.module("@opencode-ai/console-core/black.js", () => ({ BlackData: { productID: () => "prod_black" } }))
await mock.module("@opencode-ai/console-core/referral.js", () => ({
  Referral: {
    completeFromLiteSubscription: async () => {
      referralCalls++
    },
  },
}))
await mock.module("@opencode-ai/console-core/billing.js", () => ({
  Billing: {
    get: async () => ({ ...rows.billing.find((row) => row.workspaceID === actor.getStore()) }),
    redeemCoupon: async () => {
      couponRedemptions++
    },
    stripe: () => ({
      webhooks: verifier,
      customers: { update: async () => ({}) },
      paymentMethods: { retrieve: async () => ({ id: "pm_test", type: "card", card: { last4: "4242" } }) },
      paymentIntents: {
        retrieve: async (id: string) => {
          paymentIntentRequests.push(id)
          if (!id.startsWith("pi_")) throw new Error("Invoice ID passed to PaymentIntent API")
          return stripePaymentIntent
        },
      },
      invoices: {
        retrieve: async (id: string) => {
          invoiceRequests.push(id)
          return stripeInvoice
        },
      },
    }),
  },
}))
const { POST } = await import("../src/routes/stripe/webhook")
const log = spyOn(console, "log").mockImplementation(() => {})
afterAll(() => {
  log.mockRestore()
  mock.restore()
})
beforeEach(() => {
  rows = { billing: [{ workspaceID: "ws_test", customerID: "cus_test", balance: 0 }], payment: [], lite: [] }
  failPaymentInsert = false
  failRefundBalance = false
  couponRedemptions = 0
  referralCalls = 0
  stripeInvoice = {
    customer: "cus_test",
    status: "open",
    paid: false,
    payments: { data: [{ payment: { payment_intent: "pi_test" } }] },
    discounts: [],
  }
  stripePaymentIntent = {
    customer: "cus_test",
    payment_method: { id: "pm_test", type: "card", card: { last4: "4242" } },
    last_payment_error: { message: "Card declined" },
    client_secret: "pi_secret_offline_must_not_log",
  }
  paymentIntentRequests = []
  invoiceRequests = []
  failReloadUpdate = false
  log.mockClear()
  queue = Promise.resolve()
})

function event(type: string, object: Row) {
  return { id: "evt_test", object: "event", type, created: 1_700_000_000, data: { object } }
}
function checkout(customer = "cus_test", invoice = "in_test") {
  return event("checkout.session.completed", {
    mode: "payment",
    metadata: { workspaceID: "ws_test", amount: "100" },
    customer,
    payment_intent: "pi_test",
    invoice,
  })
}
function invoice(reason = "manual", customer = "cus_test") {
  return event("invoice.payment_succeeded", {
    id: "in_test",
    billing_reason: reason,
    amount_paid: 100,
    customer,
    metadata: { workspaceID: "ws_test", amount: "100" },
    parent: { subscription_details: { subscription: "sub_test" } },
    lines: { data: [{ pricing: { price_details: { product: "prod_lite" } } }] },
    currency: "usd",
  })
}
function refund() {
  return event("charge.refunded", { customer: "cus_test", payment_intent: "pi_test" })
}
function failedInvoice(type = "invoice.payment_failed", customer = "cus_test") {
  return event(type, { ...invoice("manual", customer).data.object })
}
async function send(body: Row, valid = true) {
  const payload = JSON.stringify(body)
  const signature = await verifier.generateTestHeaderStringAsync({ payload, secret: valid ? secret : "wrong_secret" })
  return POST({
    request: new Request("http://localhost/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": signature },
      body: payload,
    }),
  } as APIEvent)
}

describe("Stripe webhook payment idempotency", () => {
  for (const [name, body] of [
    ["checkout", checkout()],
    ["manual invoice", invoice()],
    ["subscription invoice", invoice("subscription_cycle")],
  ] as const) {
    test(`${name}: repeated and concurrent signed deliveries record one payment`, async () => {
      const responses = await Promise.all([send(body), send(body), send(body)])
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
      expect((await send(body)).status).toBe(200)
      expect(rows.payment).toHaveLength(1)
      expect(rows.billing[0].balance).toBe(name === "subscription invoice" ? 0 : 100_000_000)
    })
  }
  test("payment intent deduplicates deliveries with differing invoice IDs", async () => {
    await send(checkout())
    await send(checkout("cus_test", "in_other"))
    expect(rows.payment).toHaveLength(1)
    expect(rows.billing[0].balance).toBe(100_000_000)
  })
  test("different event types for one payment do not credit it twice", async () => {
    const responses = await Promise.all([send(checkout()), send(invoice())])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(rows.payment).toHaveLength(1)
    expect(rows.billing[0].balance).toBe(100_000_000)
  })
  test("coupon invoices without a payment intent deduplicate by invoice ID", async () => {
    stripeInvoice = { payments: { data: [] }, discounts: [{ coupon: { id: "coupon_free" } }] }
    const body = invoice("subscription_create")
    body.data.object.amount_paid = 0
    const responses = await Promise.all([send(body), send(body)])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(rows.payment).toHaveLength(1)
    expect(rows.payment[0].amount).toBe(0)
    expect(rows.payment[0].paymentID).toBeUndefined()
  })
  test("failed payment insert rolls back the credit and can retry", async () => {
    failPaymentInsert = true
    expect((await send(invoice())).status).toBe(500)
    expect(rows.payment).toHaveLength(0)
    expect(rows.billing[0].balance).toBe(0)
    expect((await send(invoice())).status).toBe(200)
    expect(rows.payment).toHaveLength(1)
    expect(rows.billing[0].balance).toBe(100_000_000)
  })
  test("manual invoice and checkout reject another customer's workspace", async () => {
    expect((await send(invoice("manual", "cus_other"))).status).toBe(500)
    expect((await send(checkout("cus_other"))).status).toBe(500)
    expect(rows.payment).toHaveLength(0)
    expect(rows.billing[0].balance).toBe(0)
  })
  test("concurrent first checkout binds one customer", async () => {
    rows.billing[0].customerID = null
    const responses = await Promise.all([send(checkout()), send(checkout("cus_other"))])
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 500])
    expect(rows.payment).toHaveLength(1)
    expect(rows.billing[0].balance).toBe(100_000_000)
  })
  test("signature failure rejects before database writes", async () => {
    let failure: unknown
    try {
      await send(checkout(), false)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(rows.payment).toHaveLength(0)
    expect(rows.billing[0].balance).toBe(0)
  })
  test("concurrent refunds and later retries deduct credit once", async () => {
    await send(checkout())
    const responses = await Promise.all([send(refund()), send(refund()), send(refund())])
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
    expect((await send(refund())).status).toBe(200)
    expect(rows.billing[0].balance).toBe(0)
    expect(rows.payment[0].timeRefunded).toEqual(new Date(1_700_000_000_000))
  })
  test("failed refund rolls back its marker and can retry", async () => {
    await send(checkout())
    failRefundBalance = true
    expect((await send(refund())).status).toBe(500)
    expect(rows.payment[0].timeRefunded).toBeUndefined()
    expect(rows.billing[0].balance).toBe(100_000_000)
    expect((await send(refund())).status).toBe(200)
    expect(rows.billing[0].balance).toBe(0)
  })
  test("subscription refunds do not deduct top-up credit", async () => {
    rows.billing[0].balance = 500
    await send(invoice("subscription_cycle"))
    await send(refund())
    expect(rows.billing[0].balance).toBe(500)
    expect(rows.payment[0].timeRefunded).toBeDefined()
  })
  test("subscription created retries do not recreate entitlement or redeem twice", async () => {
    const subscription = event("customer.subscription.created", {
      id: "sub_test",
      customer: "cus_test",
      latest_invoice: "in_test",
      default_payment_method: "pm_test",
      metadata: {
        type: "lite",
        workspaceID: "ws_test",
        userID: "user_test",
        userEmail: "test@example.test",
        coupon: "coupon50",
      },
    })
    const responses = await Promise.all([send(subscription), send(subscription)])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(rows.lite).toHaveLength(1)
    expect(couponRedemptions).toBe(1)
    expect(referralCalls).toBe(2)
  })
})

describe("manual invoice failure handling", () => {
  for (const type of ["invoice.payment_failed", "invoice.payment_action_required"]) {
    test(`${type} retrieves the invoice's PaymentIntent and records its error`, async () => {
      rows.billing[0].reload = true
      expect((await send(failedInvoice(type))).status).toBe(200)
      expect(invoiceRequests).toEqual(["in_test"])
      expect(paymentIntentRequests).toEqual(["pi_test"])
      expect(rows.billing[0].reload).toBe(false)
      expect(rows.billing[0].reloadError).toBe("Card declined")
      expect(rows.billing[0].timeReloadError).toBeInstanceOf(Date)
      expect(JSON.stringify(log.mock.calls)).not.toContain("pi_secret_offline_must_not_log")
    })
  }
  test("expanded PaymentIntent IDs and customer IDs are supported", async () => {
    stripeInvoice.customer = { id: "cus_test" }
    stripeInvoice.payments.data[0].payment.payment_intent = { id: "pi_test" }
    stripePaymentIntent.customer = { id: "cus_test" }
    const body = failedInvoice()
    body.data.object.customer = { id: "cus_test" }
    expect((await send(body)).status).toBe(200)
    expect(paymentIntentRequests).toEqual(["pi_test"])
    expect(rows.billing[0].reloadError).toBe("Card declined")
  })
  test("charge entries before the PaymentIntent do not hide its error", async () => {
    stripeInvoice.payments.data.unshift({ payment: { charge: "ch_test" } })
    expect((await send(failedInvoice())).status).toBe(200)
    expect(paymentIntentRequests).toEqual(["pi_test"])
    expect(rows.billing[0].reloadError).toBe("Card declined")
  })
  test("no PaymentIntent records the fallback without calling its API", async () => {
    stripeInvoice.payments = { data: [] }
    expect((await send(failedInvoice("invoice.payment_action_required"))).status).toBe(200)
    expect(paymentIntentRequests).toEqual([])
    expect(rows.billing[0].reloadError).toBe("workspace.reload.error.paymentFailed")
  })
  test("missing payment error uses the fallback", async () => {
    delete stripePaymentIntent.last_payment_error
    expect((await send(failedInvoice())).status).toBe(200)
    expect(rows.billing[0].reloadError).toBe("workspace.reload.error.paymentFailed")
  })
  test("another customer's workspace is rejected before Stripe lookups", async () => {
    rows.billing[0].reload = true
    expect((await send(failedInvoice("invoice.payment_failed", "cus_other"))).status).toBe(500)
    expect(invoiceRequests).toEqual([])
    expect(paymentIntentRequests).toEqual([])
    expect(rows.billing[0].reload).toBe(true)
  })
  test("a retrieved invoice for another customer cannot change reload state", async () => {
    rows.billing[0].reload = true
    stripeInvoice.customer = "cus_other"
    expect((await send(failedInvoice())).status).toBe(500)
    expect(paymentIntentRequests).toEqual([])
    expect(rows.billing[0].reload).toBe(true)
  })
  test("a PaymentIntent for another customer cannot change reload state", async () => {
    rows.billing[0].reload = true
    stripePaymentIntent.customer = { id: "cus_other" }
    expect((await send(failedInvoice())).status).toBe(500)
    expect(rows.billing[0].reload).toBe(true)
    expect(rows.billing[0].reloadError).toBeUndefined()
  })
  test("late failure after local success leaves billing untouched", async () => {
    rows.billing[0].reload = true
    await send(invoice())
    const before = structuredClone(rows.billing[0])
    invoiceRequests = []
    expect((await send(failedInvoice())).status).toBe(200)
    expect(rows.billing[0]).toEqual(before)
    expect(invoiceRequests).toEqual([])
    expect(paymentIntentRequests).toEqual([])
  })
  test("local success with the same PaymentIntent also suppresses a late failure", async () => {
    rows.billing[0].reload = true
    await send(checkout("cus_test", "in_other"))
    const before = structuredClone(rows.billing[0])
    paymentIntentRequests = []
    expect((await send(failedInvoice())).status).toBe(200)
    expect(rows.billing[0]).toEqual(before)
    expect(paymentIntentRequests).toEqual([])
  })
  test("a currently paid Stripe invoice ignores an old failure without a local record", async () => {
    rows.billing[0].reload = true
    stripeInvoice.status = "paid"
    stripeInvoice.paid = true
    expect((await send(failedInvoice())).status).toBe(200)
    expect(paymentIntentRequests).toEqual([])
    expect(rows.billing[0].reload).toBe(true)
    expect(rows.billing[0].reloadError).toBeUndefined()
  })
  test("a succeeded PaymentIntent ignores its old failure before the invoice becomes paid", async () => {
    rows.billing[0].reload = true
    stripePaymentIntent.status = "succeeded"
    expect((await send(failedInvoice())).status).toBe(200)
    expect(rows.billing[0].reload).toBe(true)
    expect(rows.billing[0].reloadError).toBeUndefined()
  })
  test("duplicate failures and rollback retries preserve balance and payment history", async () => {
    rows.billing[0].balance = 500
    rows.billing[0].reload = true
    failReloadUpdate = true
    expect((await send(failedInvoice())).status).toBe(500)
    expect(rows.billing[0].reload).toBe(true)
    expect(rows.billing[0].reloadError).toBeUndefined()
    const responses = await Promise.all([send(failedInvoice()), send(failedInvoice())])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(rows.billing[0].reloadError).toBe("Card declined")
    expect(rows.billing[0].balance).toBe(500)
    expect(rows.payment).toHaveLength(0)
  })
})
