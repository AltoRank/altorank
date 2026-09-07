// ---------------------------------------------------------------------------
// Where to send somebody after they sign in
// ---------------------------------------------------------------------------
//
// Eight of the twenty-four emails this product sends end in "open the draft",
// "review the proposed changes", "open the review queue". Every one of those
// links is auth-gated, and the middleware used to answer them by cloning the
// URL and overwriting only the pathname:
//
//     GET /articles?status=review  →  307 /signin?status=review
//
// The query survived and the destination did not, so the reader signed in and
// arrived at /dashboard with no idea which article the email was about. The
// path travels in `next=` now, and this is the only thing allowed to read it.
//
// A redirect target taken from a URL is an open redirect unless something
// refuses the hostile shapes, and "starts with a slash" is not that something:
// `//evil.com` and `/\evil.com` both start with one and both send the browser
// to another origin. So the rule here is narrow on purpose - one leading slash,
// nothing that parses as having an origin of its own - and everything else is
// dropped in favour of the default. A dropped `next` costs the reader one
// click; an honoured one costs them their session on somebody else's page.

/** The page a signed-in person lands on when there is nowhere better. */
export const DEFAULT_AFTER_SIGN_IN = "/dashboard";

/**
 * The relative path in `next`, or null if it is anything else.
 *
 * Accepts only a same-origin relative reference: one leading `/`, no scheme, no
 * authority. Rejects absolute URLs, protocol-relative `//host`, the backslash
 * variants browsers normalise into them, control characters (a header-splitting
 * newline among them), and a bounce back to the auth pages themselves.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 2048) return null;

  // Must be rooted, and rooted exactly once. `//evil.com` is protocol-relative;
  // `/\evil.com` and `/%5Cevil.com` are the shapes browsers normalise into it.
  if (!value.startsWith("/")) return null;
  if (/^\/[/\\]/.test(value)) return null;
  if (/^\/%2[fF]/.test(value) || /^\/%5[cC]/.test(value)) return null;
  // Control characters, including CR/LF: never useful, and a header splitter.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return null;

  // Parse against a base that cannot be reached, so anything that carries its
  // own origin - "https://evil.com", "//evil.com" - shows up as a changed one.
  let url: URL;
  try {
    url = new URL(value, "http://next-path.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://next-path.invalid") return null;
  if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) return null;

  // Sending somebody back to the page they just left is a loop, not a destination.
  if (/^\/(signin|signup)(\/|$)/.test(url.pathname)) return null;

  return `${url.pathname}${url.search}${url.hash}`;
}

/** The validated `next`, or the dashboard. */
export function afterSignIn(raw: string | null | undefined): string {
  return safeNextPath(raw) ?? DEFAULT_AFTER_SIGN_IN;
}
