/** Only a local application path may be selected as the post-checkout destination. */
export function checkoutDestination(value: unknown): string {
  if (typeof value !== "string" || !/^\/[a-zA-Z0-9/_?=&%-]*$/.test(value) || value.startsWith("//")) return "/dashboard";
  // Percent-encoded slashes/backslashes must not turn a local URL into an origin.
  try { if (decodeURIComponent(value).startsWith("//") || decodeURIComponent(value).includes("\\")) return "/dashboard"; } catch { return "/dashboard"; }
  return value;
}

/** Where the trial screen shows "Checkout was cancelled" and the offer again. */
export const TRIAL_CANCELLED_PATH = "/onboarding?status=cancelled";

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
