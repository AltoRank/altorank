import type Stripe from "stripe";

/**
 * Invoice the customer's pending charges now, rather than leaving them for a
 * next renewal that will not come or will not be collected.
 *
 * An overage charge (lib/billing/overage.ts) waits as a pending invoice item for the next invoice the
 * subscription makes. Two moments break that:
 *
 *   the plan ends     a subscription cancelled at period end makes no final
 *                     invoice, so the last period's overage was never billed
 *                     (or landed on the first invoice after a resubscribe);
 *   a pause starts    `pause_collection: void` voids the renewal invoice that
 *                     pulls the pending items in, so the month's overage was
 *                     voided with the fee.
 *
 * Returns the invoice id, or null when nothing was pending. `auto_advance`
 * means a finalisation that fails here is retried by Stripe within the hour,
 * so a caller that retries finds nothing pending and does not bill twice.
 */
export async function invoicePendingCharges(
  stripe: Stripe,
  customerId: string,
  /**
   * The subscription whose card pays it. Checkout saves the card on the
   * subscription (`default_payment_method`), not as the customer's invoice
   * default, and an invoice with no subscription only looks at the
   * customer's - so without this the charge was attempted with no card and
   * the invoice sat open. `paymentMethod` when the caller already holds the
   * subscription, `subscriptionId` to have it read.
   */
  payer: { paymentMethod?: string | null; subscriptionId?: string | null } = {},
): Promise<string | null> {
  const pending = await stripe.invoiceItems.list({ customer: customerId, pending: true, limit: 1 });
  if (pending.data.length === 0) return null;
  let paymentMethod = payer.paymentMethod ?? null;
  if (!paymentMethod && payer.subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(payer.subscriptionId);
      paymentMethod = paymentMethodId(sub.default_payment_method);
    } catch {
      // The customer's own default, if it has one, still pays it.
    }
  }
  const invoice = await stripe.invoices.create({
    customer: customerId,
    pending_invoice_items_behavior: "include",
    collection_method: "charge_automatically",
    auto_advance: true,
    description: "Additional articles beyond the monthly included volume",
    ...(paymentMethod ? { default_payment_method: paymentMethod } : {}),
  });
  if (!invoice.id) throw new Error("Stripe returned an invoice with no id");
  await stripe.invoices.finalizeInvoice(invoice.id);
  return invoice.id;
}

/** The id of a subscription's `default_payment_method`, expanded or not. */
export function paymentMethodId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}
