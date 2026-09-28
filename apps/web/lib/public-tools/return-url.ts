// ---------------------------------------------------------------------------
// Back to the tool page after signing up or in
// ---------------------------------------------------------------------------
//
// A paid tool on altorank.co sends a signed-out visitor to
//
//   /signup?from=tools&return_to=https://altorank.co/tools/<slug>/
//   /signin?return_to=https://altorank.co/tools/<slug>/
//
// and expects them back on that page, signed in, with their input restored.
// A return URL read out of a query string is an open redirect unless it is
// refused in every shape but one, so this module accepts exactly one:
// https://altorank.co/tools/<slug>/ (trailing slash optional), where <slug> is
// lower-case letters, digits and single hyphens. No other host, no scheme but
// https, no port, no user info, no query, no fragment, no dot segments, no
// encoding.
//
// The URL itself is never carried further. It is reduced to the slug, which
// travels as the internal path /tool-return/<slug> - through the confirmation
// email and the auth callback, whose `next` accepts only a plain path - and
// that route rebuilds the page URL from a constant origin and a slug it finds
// in the tool registry. So the only external redirect in the whole trip is to
// a page this app itself names.
//
// No imports on purpose: middleware.ts reads it on the edge.

/** Where the marketing site's tool pages live. */
export const TOOLS_SITE_ORIGIN = "https://altorank.co";

/** The internal path that carries the slug through signup and the callback. */
export const TOOL_RETURN_PREFIX = "/tool-return/";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 80;

export function isToolSlugShape(slug: unknown): slug is string {
  return typeof slug === "string" && slug.length <= MAX_SLUG && SLUG.test(slug);
}

/**
 * The tool slug named by a return URL, or null for anything else. Takes
 * `unknown` because callers read it from search params and FormData.
 */
export function toolSlugFromReturnUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 200) return null;
  const prefix = `${TOOLS_SITE_ORIGIN}/tools/`;
  if (!value.startsWith(prefix)) return null;
  const rest = value.slice(prefix.length);
  const slug = rest.endsWith("/") ? rest.slice(0, -1) : rest;
  return isToolSlugShape(slug) ? slug : null;
}

/** `/tool-return/<slug>`, the `next` that carries a tool return. */
export function toolReturnPath(slug: string): string {
  return `${TOOL_RETURN_PREFIX}${slug}`;
}

/** The slug in a `/tool-return/<slug>` path, or null. */
export function slugFromToolReturnPath(path: unknown): string | null {
  if (typeof path !== "string" || !path.startsWith(TOOL_RETURN_PREFIX)) return null;
  const slug = path.slice(TOOL_RETURN_PREFIX.length);
  return isToolSlugShape(slug) ? slug : null;
}

/**
 * The page a tool return lands on. `run=1` asks the widget to restore the
 * saved input and run it once; the widget removes it from the address bar.
 */
export function toolPageUrl(slug: string | null): string {
  return slug ? `${TOOLS_SITE_ORIGIN}/tools/${slug}/?run=1` : `${TOOLS_SITE_ORIGIN}/tools/`;
}
