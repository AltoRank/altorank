/** Only a local application path may be selected as the post-checkout destination. */
export function checkoutDestination(value: unknown): string {
  if (typeof value !== "string" || !/^\/[a-zA-Z0-9/_?=&%-]*$/.test(value) || value.startsWith("//")) return "/dashboard";
  // Percent-encoded slashes/backslashes must not turn a local URL into an origin.
  try { if (decodeURIComponent(value).startsWith("//") || decodeURIComponent(value).includes("\\")) return "/dashboard"; } catch { return "/dashboard"; }
  return value;
}
