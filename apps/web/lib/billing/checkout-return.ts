/** Only a local application path may be selected as the post-checkout destination. */
export function checkoutDestination(value: unknown): string {
  if (typeof value !== "string" || !/^\/[a-zA-Z0-9/_?=&%-]*$/.test(value) || value.startsWith("//")) return "/dashboard";
  // Percent-encoded slashes/backslashes must not turn a local URL into an origin.
  try { if (decodeURIComponent(value).startsWith("//") || decodeURIComponent(value).includes("\\")) return "/dashboard"; } catch { return "/dashboard"; }
  return value;
}

/**
 * Where a trial started from the gate lands once it is active: the first
 * article, open to edit and approve - the thing the card was asked for - and
 * not the dashboard, whose tiles are still empty on day one (UX clarity
 * audit 2026-10-18, #1). No article yet: the dashboard, as before.
 *
 * `editorFits`: below md the editor keeps its desktop panes inside a sideways
 * scroller (article-editor.tsx), with Approve and Copy off screen, so a phone
 * lands on the dashboard instead, whose Next up links the article (verified
 * finding "phone-editor", 2026-10-18). Back to the article once the editor
 * has a phone layout.
 */
export function firstArticleReturn(articleId: string | null | undefined, editorFits = true): string {
  if (!editorFits) return "/dashboard";
  return articleId && /^[a-zA-Z0-9-]+$/.test(articleId) ? `/content/${articleId}` : "/dashboard";
}

/** The viewport from which the editor shows its panes without a sideways scroll: Tailwind's md. */
export const EDITOR_FITS_QUERY = "(min-width: 768px)";

/** Where the trial screen shows "Checkout was cancelled" and the offer again. */
export const TRIAL_CANCELLED_PATH = "/onboarding?status=cancelled";

/** The trial screen with no notice: back from the cancel page when nobody left Stripe's page. */
export const TRIAL_GATE_PATH = "/onboarding";

/**
 * The `from` value on Stripe's back link (the hosted cancel_url). Only with it
 * does /checkout/cancelled say the owner left checkout and record
 * checkout_cancelled: the "Manage open checkout" link lands there too.
 */
export const STRIPE_CANCEL_MARK = "stripe";

/**
 * Where "Cancel checkout and return" lands. The cancel page names it: the
 * trial screen for an account still behind the trial gate, Billing for
 * everyone else. Anything that is not a local path falls back like any other
 * post-checkout destination; nothing at all is the trial screen, which is
 * where the button always went before it was told.
 */
export function cancelledCheckoutReturn(value: unknown): string {
  if (typeof value !== "string" || value === "") return TRIAL_CANCELLED_PATH;
  return checkoutDestination(value);
}

/**
 * Billing, carrying on the destination the purchase was for, so a person who
 * came to Billing from another screen still goes back there after paying.
 * `next` is already a checked local path (`checkoutDestination`); the default
 * destination is not worth a query string.
 */
export function billingReturnPath(next: string): string {
  return next && next !== "/dashboard" ? `/settings/billing?return=${encodeURIComponent(next)}` : "/settings/billing";
}
