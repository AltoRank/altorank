// ---------------------------------------------------------------------------
// The address this deployment answers on
// ---------------------------------------------------------------------------
//
// Five files each read NEXT_PUBLIC_APP_URL into their own module-level
// constant, and they did not agree on the fallback: `localhost:3000` in
// app/actions/team.ts and app/actions/audit.ts, `localhost:3100` in the two
// email modules and in app/actions/billing.ts. Whichever one was right, the
// other three built links to a port nobody is serving.
//
// Worse than the disagreement is what the fallback does in production. An
// unset variable on Vercel silently turned every confirmation link, invite
// link and draft link into `http://localhost:...` - a link that looks fine in
// the inbox and cannot possibly work. Nothing failed; the mail just arrived
// useless.
//
// So: one reader, and in production a missing value is an error rather than a
// localhost link. Callers reach it through a function, never a module-level
// constant, because `next build` runs with NODE_ENV=production and a constant
// would turn a missing variable into a failed build instead of a failed send.

/** The port `npm run dev` uses for apps/web. */
const DEV_FALLBACK = "http://localhost:3100";

let warned = false;

/**
 * The deployment's public base URL, without a trailing slash.
 *
 * Throws in production when NEXT_PUBLIC_APP_URL is unset: a mailed link
 * pointing at localhost is a defect that reaches the customer, and a send that
 * fails loudly is recoverable where a wrong link is not.
 */
export function appUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_APP_URL is not set, so any link built here would point at localhost. Set it on the deployment.",
    );
  }
  if (!warned) {
    warned = true;
    console.warn(`[app-url] NEXT_PUBLIC_APP_URL is not set; using ${DEV_FALLBACK}`);
  }
  return DEV_FALLBACK;
}

/** An absolute URL for a path on this deployment. */
export function appLink(path: string): string {
  return new URL(path, appUrl()).toString();
}
