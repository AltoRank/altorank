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
export async function invoicePendingCharges(stripe: Stripe, customerId: string): Promise<string | null> {
  const pending = await stripe.invoiceItems.list({ customer: customerId, pending: true, limit: 1 });
  if (pending.data.length === 0) return null;
  const invoice = await stripe.invoices.create({
    customer: customerId,
    pending_invoice_items_behavior: "include",
    collection_method: "charge_automatically",
    auto_advance: true,
    description: "Additional articles beyond the monthly included volume",
  });
  if (!invoice.id) throw new Error("Stripe returned an invoice with no id");
  await stripe.invoices.finalizeInvoice(invoice.id);
  return invoice.id;
}
