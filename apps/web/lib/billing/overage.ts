import type { SupabaseClient } from "@supabase/supabase-js";
import { billingEnabled, getStripe } from "@/lib/stripe";
import { OVERAGE_CENTS, type Quota } from "@/lib/billing/quota";

/**
 * Bill one article past the included volume, at the price the pricing page
 * publishes. An invoice item lands on the next subscription invoice, which is
 * how "€0.60 per additional article" becomes a real line a customer can read
 * instead of copy.
 *
 * The article's id is written on the item (`metadata.article_id`), so a draft
 * deleted while its charge is still pending takes the charge back with it
 * (`removePendingOverage`).
 *
 * Best-effort: if Stripe is unreachable the article still generates and the
 * failure is logged. Refusing paid-for work over a billing hiccup is worse
 * than occasionally under-billing sixty cents.
 */
export async function recordOverageArticle(
  supabase: SupabaseClient,
  accountId: string,
  quota: Quota,
  articleId: string | null = null,
): Promise<void> {
  if (quota.plan !== "starter" && quota.plan !== "growth") return;
  const cents = OVERAGE_CENTS[quota.plan];

  try {
    const { data: account } = await supabase
      .from("accounts")
      .select("stripe_customer_id")
      .eq("id", accountId)
      .single();
    if (!account?.stripe_customer_id) return;

    await getStripe().invoiceItems.create({
      customer: account.stripe_customer_id,
      amount: cents,
      currency: "eur",
      description: "Additional article beyond the monthly included volume",
      ...(articleId ? { metadata: { account_id: accountId, article_id: articleId } } : {}),
    });
  } catch (err) {
    console.warn("[billing] overage invoice item failed:", err);
  }
}

/**
 * Take back the overage charge of a deleted draft, while it is still pending.
 *
 * Deleting a draft gives its slot back (the count is of articles that exist),
 * so the next draft past the volume is billed again. Without this a billed
 * draft that was then deleted cost its charge AND freed a slot for a second
 * one: two charges for one surviving article. A charge already on a finalised
 * invoice is not reached here and is not refunded.
 *
 * Best-effort, like the charge: the delete has already happened and must not
 * fail over Stripe. Returns how many pending charges were removed.
 */
export async function removePendingOverage(
  supabase: SupabaseClient,
  accountId: string,
  articleId: string,
): Promise<number> {
  if (!billingEnabled) return 0;
  try {
    const { data: account } = await supabase
      .from("accounts")
      .select("stripe_customer_id")
      .eq("id", accountId)
      .maybeSingle();
    const customer = account?.stripe_customer_id as string | null | undefined;
    if (!customer) return 0;
    const stripe = getStripe();
    const pending = await stripe.invoiceItems.list({ customer, pending: true, limit: 100 });
    const mine = pending.data.filter((item) => item.metadata?.article_id === articleId);
    for (const item of mine) await stripe.invoiceItems.del(item.id);
    return mine.length;
  } catch (err) {
    console.warn("[billing] overage refund on delete failed:", err);
    return 0;
  }
}
