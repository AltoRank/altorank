// ---------------------------------------------------------------------------
// Is it safe to let Stripe add VAT on this price?
// ---------------------------------------------------------------------------
//
// `automatic_tax` is only right when the Price is tax-EXCLUSIVE. Stripe's
// account default ("Include tax in prices: Automatic") treats every non-USD/
// CAD price as tax-inclusive, and a Price whose own `tax_behavior` is
// `inclusive` cannot be edited back. On euro prices that means Stripe reads
// EUR 69 as VAT-included and carves the tax out of it: EUR 56.56 arrives
// instead of EUR 69, with nothing in Checkout to say so. docs/deploy.md
// "Stripe" has the two dashboard steps; this is the check that the flag
// (STRIPE_TAX_ENABLED) was turned on after them, not before.
//
// Asked of the one price being sold, at checkout time, so a mis-set price
// falls back to what the deployment did before the flag existed - charge the
// listed amount with no tax - rather than quietly under-charging. The
// fallback is logged: silently charging no VAT is the state the flag exists
// to end, so it must not be silent.

type PriceReader = { prices: { retrieve: (id: string) => Promise<{ tax_behavior?: string | null }> } };

export async function priceIsTaxExclusive(stripe: PriceReader, priceId: string): Promise<boolean> {
  try {
    const price = await stripe.prices.retrieve(priceId);
    if (price.tax_behavior === "exclusive") return true;
    console.error(
      `[billing] STRIPE_TAX_ENABLED is on but price ${priceId} has tax_behavior=${price.tax_behavior ?? "unspecified"}; ` +
        "checkout will not add VAT for it. Set the Price (or the account default) to exclusive.",
    );
    return false;
  } catch (err) {
    console.error(`[billing] could not read price ${priceId} to confirm tax_behavior; checkout will not add VAT:`, err);
    return false;
  }
}
