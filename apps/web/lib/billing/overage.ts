import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { OVERAGE_CENTS, type Quota } from "@/lib/billing/quota";

/**
 * Bill one article past the included volume, at the price the pricing page
 * publishes. An invoice item lands on the next subscription invoice, which is
 * how "€0.60 per additional article" becomes a real line a customer can read
 * instead of copy.
 *
 * Best-effort: if Stripe is unreachable the article still generates and the
 * failure is logged. Refusing paid-for work over a billing hiccup is worse
 * than occasionally under-billing sixty cents.
 */
export async function recordOverageArticle(
  supabase: SupabaseClient,
  agencyId: string,
  quota: Quota,
): Promise<void> {
  if (quota.plan !== "starter" && quota.plan !== "growth") return;
  const cents = OVERAGE_CENTS[quota.plan];

  try {
    const { data: agency } = await supabase
      .from("agencies")
      .select("stripe_customer_id")
      .eq("id", agencyId)
      .single();
    if (!agency?.stripe_customer_id) return;

    await getStripe().invoiceItems.create({
      customer: agency.stripe_customer_id,
      amount: cents,
      currency: "eur",
      description: "Additional article beyond the monthly included volume",
    });
  } catch (err) {
    console.warn("[billing] overage invoice item failed:", err);
  }
}
