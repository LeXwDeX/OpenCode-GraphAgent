import type { Stripe } from "stripe"
import { Billing } from "@opencode-ai/console-core/billing.js"
import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, or, sql } from "@opencode-ai/console-core/drizzle/index.js"
import { BillingTable, LiteTable, PaymentTable } from "@opencode-ai/console-core/schema/billing.sql.js"
import { Identifier } from "@opencode-ai/console-core/identifier.js"
import { centsToMicroCents } from "@opencode-ai/console-core/util/price.js"
import { Actor } from "@opencode-ai/console-core/actor.js"
import { Resource } from "@opencode-ai/console-resource"
import { LiteData } from "@opencode-ai/console-core/lite.js"
import { BlackData } from "@opencode-ai/console-core/black.js"
import { Referral } from "@opencode-ai/console-core/referral.js"

async function lockBilling(tx: Database.TxOrDb, workspaceID: string, customerID: string, allowNew = false) {
  const billing = await tx
    .select()
    .from(BillingTable)
    .where(eq(BillingTable.workspaceID, workspaceID))
    .for("update")
    .then((rows) => rows[0])
  if (!billing) throw new Error(`Workspace with ID ${workspaceID} not found`)
  if (billing.customerID !== customerID && !(allowNew && !billing.customerID)) throw new Error("Customer ID mismatch")
  return billing
}

async function hasPayment(tx: Database.TxOrDb, workspaceID: string, invoiceID: string, paymentID?: string) {
  // Billing is locked first by every payment writer. Use a current read after acquiring it.
  return tx
    .select({ id: PaymentTable.id })
    .from(PaymentTable)
    .where(
      and(
        eq(PaymentTable.workspaceID, workspaceID),
        or(eq(PaymentTable.invoiceID, invoiceID), paymentID ? eq(PaymentTable.paymentID, paymentID) : undefined),
      ),
    )
    .for("update")
    .then((rows) => rows.length > 0)
}

export async function POST(input: APIEvent) {
  const body = await Billing.stripe().webhooks.constructEventAsync(
    await input.request.text(),
    input.request.headers.get("stripe-signature")!,
    Resource.STRIPE_WEBHOOK_SECRET.value,
  )
  console.log("Stripe webhook", { id: body.id, type: body.type })

  return (async () => {
    if (body.type === "customer.updated") {
      // check default payment method changed
      const prevInvoiceSettings = body.data.previous_attributes?.invoice_settings ?? {}
      if (!("default_payment_method" in prevInvoiceSettings)) return "ignored"

      const customerID = body.data.object.id
      const paymentMethodID = body.data.object.invoice_settings.default_payment_method as string

      if (!customerID) throw new Error("Customer ID not found")
      if (!paymentMethodID) throw new Error("Payment method ID not found")

      const paymentMethod = await Billing.stripe().paymentMethods.retrieve(paymentMethodID)
      await Database.use(async (tx) => {
        await tx
          .update(BillingTable)
          .set({
            paymentMethodID,
            paymentMethodLast4: paymentMethod.card?.last4 ?? null,
            paymentMethodType: paymentMethod.type,
          })
          .where(eq(BillingTable.customerID, customerID))
      })
    }
    if (body.type === "checkout.session.completed" && body.data.object.mode === "payment") {
      const workspaceID = body.data.object.metadata?.workspaceID
      const amountInCents = body.data.object.metadata?.amount && parseInt(body.data.object.metadata?.amount)
      const customerID = body.data.object.customer as string
      const paymentID = body.data.object.payment_intent as string
      const invoiceID = body.data.object.invoice as string

      if (!workspaceID) throw new Error("Workspace ID not found")
      if (!customerID) throw new Error("Customer ID not found")
      if (!amountInCents) throw new Error("Amount not found")
      if (!paymentID) throw new Error("Payment ID not found")
      if (!invoiceID) throw new Error("Invoice ID not found")

      await Actor.provide("system", { workspaceID }, async () => {
        const customer = await Billing.get()
        if (customer?.customerID && customer.customerID !== customerID) throw new Error("Customer ID mismatch")

        // set customer metadata
        if (!customer?.customerID) {
          await Billing.stripe().customers.update(customerID, {
            metadata: {
              workspaceID,
            },
          })
        }

        // get payment method for the payment intent
        const paymentIntent = await Billing.stripe().paymentIntents.retrieve(paymentID, {
          expand: ["payment_method"],
        })
        const paymentMethod = paymentIntent.payment_method
        if (!paymentMethod || typeof paymentMethod === "string") throw new Error("Payment method not expanded")

        await Database.transaction(async (tx) => {
          const billing = await lockBilling(tx, workspaceID, customerID, true)
          if (await hasPayment(tx, workspaceID, invoiceID, paymentID)) return
          await tx
            .update(BillingTable)
            .set({
              balance: sql`${BillingTable.balance} + ${centsToMicroCents(amountInCents)}`,
              customerID,
              paymentMethodID: paymentMethod.id,
              paymentMethodLast4: paymentMethod.card?.last4 ?? null,
              paymentMethodType: paymentMethod.type,
              // enable reload if first time enabling billing
              ...(billing.customerID
                ? {}
                : {
                    reloadError: null,
                    timeReloadError: null,
                  }),
            })
            .where(eq(BillingTable.workspaceID, workspaceID))
          await tx.insert(PaymentTable).values({
            workspaceID,
            id: Identifier.create("payment"),
            amount: centsToMicroCents(amountInCents),
            paymentID,
            invoiceID,
            customerID,
          })
        })
      })
    }
    if (body.type === "customer.subscription.created") {
      const type = body.data.object.metadata?.type
      if (type === "lite") {
        const workspaceID = body.data.object.metadata?.workspaceID
        const userID = body.data.object.metadata?.userID
        const userEmail = body.data.object.metadata?.userEmail
        const coupon = body.data.object.metadata?.coupon
        const customerID = body.data.object.customer as string
        const invoiceID = body.data.object.latest_invoice as string
        const subscriptionID = body.data.object.id as string
        const paymentMethodID = body.data.object.default_payment_method as string

        if (!workspaceID) throw new Error("Workspace ID not found")
        if (!userID) throw new Error("User ID not found")
        if (!customerID) throw new Error("Customer ID not found")
        if (!invoiceID) throw new Error("Invoice ID not found")
        if (!subscriptionID) throw new Error("Subscription ID not found")
        if (!paymentMethodID) throw new Error("Payment method ID not found")

        // get payment method for the payment intent
        const paymentMethod = await Billing.stripe().paymentMethods.retrieve(paymentMethodID)
        await Actor.provide("system", { workspaceID }, async () => {
          // look up current billing
          const billing = await Billing.get()
          if (!billing) throw new Error(`Workspace with ID ${workspaceID} not found`)
          if (billing.customerID && billing.customerID !== customerID) throw new Error("Customer ID mismatch")

          // set customer metadata
          if (!billing?.customerID) {
            await Billing.stripe().customers.update(customerID, {
              metadata: {
                workspaceID,
              },
            })
          }

          await Database.transaction(async (tx) => {
            const current = await lockBilling(tx, workspaceID, customerID, true)
            if (current.liteSubscriptionID === subscriptionID) return
            await tx
              .update(BillingTable)
              .set({
                customerID,
                liteSubscriptionID: subscriptionID,
                lite: {},
                paymentMethodID: paymentMethod.id,
                paymentMethodLast4: paymentMethod.card?.last4 ?? null,
                paymentMethodType: paymentMethod.type,
              })
              .where(eq(BillingTable.workspaceID, workspaceID))

            await tx.insert(LiteTable).values({
              workspaceID,
              id: Identifier.create("lite"),
              userID: userID,
            })

            if (userEmail) {
              if (coupon === LiteData.firstMonth50Coupon) {
                await Billing.redeemCoupon(userEmail, "GO1MONTH50")
              } else if (coupon === LiteData.firstMonth100Coupon) {
                await Billing.redeemCoupon(userEmail, "GOFREEMONTH")
              } else if (coupon === LiteData.threeMonths100Coupon) {
                await Billing.redeemCoupon(userEmail, "GO3MONTHS100")
              } else if (coupon === LiteData.sixMonths100Coupon) {
                await Billing.redeemCoupon(userEmail, "GO6MONTHS100")
              } else if (coupon === LiteData.twelveMonths100Coupon) {
                await Billing.redeemCoupon(userEmail, "GO12MONTHS100")
              }
            }
          })

          await Referral.completeFromLiteSubscription({
            workspaceID,
            userID,
          }).catch((error) => {
            console.error("Referral sync failed", error)
          })
        })
      }
    }
    if (body.type === "customer.subscription.updated" && body.data.object.status === "incomplete_expired") {
      const subscriptionID = body.data.object.id
      if (!subscriptionID) throw new Error("Subscription ID not found")

      const productID = body.data.object.items.data[0].price.product as string
      if (productID === LiteData.productID()) {
        await Billing.unsubscribeLite({ subscriptionID })
      } else if (productID === BlackData.productID()) {
        await Billing.unsubscribeBlack({ subscriptionID })
      }
    }
    if (body.type === "customer.subscription.deleted") {
      const subscriptionID = body.data.object.id
      if (!subscriptionID) throw new Error("Subscription ID not found")

      const productID = body.data.object.items.data[0].price.product as string
      if (productID === LiteData.productID()) {
        await Billing.unsubscribeLite({ subscriptionID })
      } else if (productID === BlackData.productID()) {
        await Billing.unsubscribeBlack({ subscriptionID })
      }
    }
    if (body.type === "invoice.payment_succeeded") {
      if (
        body.data.object.billing_reason === "subscription_create" ||
        body.data.object.billing_reason === "subscription_cycle"
      ) {
        const invoiceID = body.data.object.id as string
        const amountInCents = body.data.object.amount_paid
        const customerID = body.data.object.customer as string
        const subscriptionID = body.data.object.parent?.subscription_details?.subscription as string
        const productID = body.data.object.lines?.data[0].pricing?.price_details?.product as string

        if (!customerID) throw new Error("Customer ID not found")
        if (!invoiceID) throw new Error("Invoice ID not found")
        if (!subscriptionID) throw new Error("Subscription ID not found")

        // get coupon id from subscription
        const invoice = await Billing.stripe().invoices.retrieve(invoiceID, {
          expand: ["discounts", "payments"],
        })
        const paymentID = invoice.payments?.data[0]?.payment.payment_intent as string
        const couponID = (invoice.discounts[0] as Stripe.Discount)?.coupon?.id as string
        if (!paymentID) {
          // payment id can be undefined when using coupon
          if (!couponID) throw new Error("Payment ID not found")
        }

        const workspaceID = await Database.use((tx) =>
          tx
            .select({ workspaceID: BillingTable.workspaceID })
            .from(BillingTable)
            .where(eq(BillingTable.customerID, customerID))
            .then((rows) => rows[0]?.workspaceID),
        )
        if (!workspaceID) throw new Error("Workspace ID not found for customer")

        await Database.transaction(async (tx) => {
          await lockBilling(tx, workspaceID, customerID)
          if (await hasPayment(tx, workspaceID, invoiceID, paymentID)) return
          await tx.insert(PaymentTable).values({
            workspaceID,
            id: Identifier.create("payment"),
            amount: centsToMicroCents(amountInCents),
            paymentID,
            invoiceID,
            customerID,
            enrichment: {
              type: productID === LiteData.productID() ? "lite" : "subscription",
              currency: body.data.object.currency === "inr" ? "inr" : undefined,
              couponID,
            },
          })
        })
      } else if (body.data.object.billing_reason === "manual") {
        const workspaceID = body.data.object.metadata?.workspaceID
        const amountInCents = body.data.object.metadata?.amount && parseInt(body.data.object.metadata?.amount)
        const invoiceID = body.data.object.id as string
        const customerID = body.data.object.customer as string

        if (!workspaceID) throw new Error("Workspace ID not found")
        if (!customerID) throw new Error("Customer ID not found")
        if (!amountInCents) throw new Error("Amount not found")
        if (!invoiceID) throw new Error("Invoice ID not found")

        await Actor.provide("system", { workspaceID }, async () => {
          // get payment id from invoice
          const invoice = await Billing.stripe().invoices.retrieve(invoiceID, {
            expand: ["payments"],
          })
          await Database.transaction(async (tx) => {
            await lockBilling(tx, workspaceID, customerID)
            const paymentIntent = invoice.payments?.data[0]?.payment.payment_intent
            const paymentID = typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id
            if (await hasPayment(tx, workspaceID, invoiceID, paymentID)) return
            await tx
              .update(BillingTable)
              .set({
                balance: sql`${BillingTable.balance} + ${centsToMicroCents(amountInCents)}`,
                reloadError: null,
                timeReloadError: null,
              })
              .where(eq(BillingTable.workspaceID, Actor.workspace()))
            await tx.insert(PaymentTable).values({
              workspaceID: Actor.workspace(),
              id: Identifier.create("payment"),
              amount: centsToMicroCents(amountInCents),
              invoiceID,
              paymentID,
              customerID,
            })
          })
        })
      }
    }
    if (body.type === "invoice.payment_failed" || body.type === "invoice.payment_action_required") {
      if (body.data.object.billing_reason === "manual") {
        const workspaceID = body.data.object.metadata?.workspaceID
        const invoiceID = body.data.object.id
        const customer = body.data.object.customer
        const customerID = typeof customer === "string" ? customer : customer?.id

        if (!workspaceID) throw new Error("Workspace ID not found")
        if (!invoiceID) throw new Error("Invoice ID not found")
        if (!customerID) throw new Error("Customer ID not found")

        await Actor.provide("system", { workspaceID }, async () => {
          await Database.transaction(async (tx) => {
            await lockBilling(tx, workspaceID, customerID)
            // A delayed failure notification must not undo a successful reload.
            if (await hasPayment(tx, workspaceID, invoiceID)) return
            const invoice = await Billing.stripe().invoices.retrieve(invoiceID, { expand: ["payments"] })
            const invoiceCustomer = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id
            if (invoiceCustomer !== customerID) throw new Error("Customer ID mismatch")
            if (invoice.status === "paid") return

            const invoicePayment = invoice.payments?.data.find((item) => item.payment.payment_intent)
            const linkedIntent = invoicePayment?.payment.payment_intent
            const paymentID = typeof linkedIntent === "string" ? linkedIntent : linkedIntent?.id
            if (paymentID && (await hasPayment(tx, workspaceID, invoiceID, paymentID))) return
            const paymentIntent = paymentID ? await Billing.stripe().paymentIntents.retrieve(paymentID) : undefined
            const intentCustomer =
              typeof paymentIntent?.customer === "string" ? paymentIntent.customer : paymentIntent?.customer?.id
            if (intentCustomer && intentCustomer !== customerID) throw new Error("Customer ID mismatch")
            if (paymentIntent?.status === "succeeded") return

            await tx
              .update(BillingTable)
              .set({
                reload: false,
                reloadError: paymentIntent?.last_payment_error?.message ?? "workspace.reload.error.paymentFailed",
                timeReloadError: sql`now()`,
              })
              .where(eq(BillingTable.workspaceID, workspaceID))
          })
        })
      }
    }
    if (body.type === "charge.refunded") {
      const customerID = body.data.object.customer as string
      const paymentIntentID = body.data.object.payment_intent as string
      if (!customerID) throw new Error("Customer ID not found")
      if (!paymentIntentID) throw new Error("Payment ID not found")

      const workspaceID = await Database.use((tx) =>
        tx
          .select({
            workspaceID: BillingTable.workspaceID,
          })
          .from(BillingTable)
          .where(eq(BillingTable.customerID, customerID))
          .then((rows) => rows[0]?.workspaceID),
      )
      if (!workspaceID) throw new Error("Workspace ID not found")

      await Database.transaction(async (tx) => {
        await lockBilling(tx, workspaceID, customerID)
        const payment = await tx
          .select({
            id: PaymentTable.id,
            amount: PaymentTable.amount,
            enrichment: PaymentTable.enrichment,
            timeRefunded: PaymentTable.timeRefunded,
          })
          .from(PaymentTable)
          .where(and(eq(PaymentTable.paymentID, paymentIntentID), eq(PaymentTable.workspaceID, workspaceID)))
          .for("update")
          .then((rows) => rows[0])
        if (!payment) throw new Error("Payment not found")
        if (payment.timeRefunded) return

        await tx
          .update(PaymentTable)
          .set({
            timeRefunded: new Date(body.created * 1000),
          })
          .where(and(eq(PaymentTable.id, payment.id), eq(PaymentTable.workspaceID, workspaceID)))

        // deduct balance only for top up
        if (!payment.enrichment?.type) {
          await tx
            .update(BillingTable)
            .set({
              balance: sql`${BillingTable.balance} - ${payment.amount}`,
            })
            .where(eq(BillingTable.workspaceID, workspaceID))
        }
      })
    }
  })()
    .then((message) => {
      return Response.json({ message: message ?? "done" }, { status: 200 })
    })
    .catch((error: any) => {
      return Response.json({ message: error.message }, { status: 500 })
    })
}
