// ---------------------------------------------------------------------------
// Where an upgrade control points, and what it remembers
// ---------------------------------------------------------------------------
//
// Every "choose a plan" link used to be a bare `/settings/billing`, which drops
// whatever the person was doing. The Billing page already knows how to carry a
// `?return=` through Stripe Checkout (app/actions/billing.ts turns it into the
// session's success URL), so the only thing missing was callers using it.
//
// Paths only, and same-origin by construction: this value reaches Stripe and
// comes back as a redirect, and `createCheckoutSession` re-validates it against
// its own pattern before it does.

/** `/settings/billing`, remembering where to come back to. */
export function billingHref(returnTo?: string | null): string {
  if (!returnTo) return "/settings/billing";
  return `/settings/billing?return=${encodeURIComponent(returnTo)}`;
}

/**
 * The editor, asking to finish the approval that the paywall interrupted.
 *
 * Stripe's success URL appends `upgraded=1`, and the editor page requires both
 * before it does anything - see app/actions/approve-intent.ts for why neither
 * is trusted to approve on its own.
 */
export function approveIntentPath(articleId: string): string {
  return `/content/${articleId}?intent=approve`;
}
