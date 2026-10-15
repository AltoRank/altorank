// ---------------------------------------------------------------------------
// The dashboard's Content-Security-Policy
// ---------------------------------------------------------------------------
//
// Built per request by the middleware with a fresh nonce. Scripts run only
// when they carry that nonce ('strict-dynamic' lets a trusted script load the
// chunks it needs - Next's own runtime, PostHog's lazy bundles), so markup
// that reaches a page some other way cannot run script even if it got past
// the HTML sanitiser (lib/html/sanitize.ts). Next reads the nonce from the
// request's CSP header and stamps it on every script it renders; the root
// layout stamps it on the one inline script of its own (the theme init).
//
// The rest names what the app talks to: Supabase (REST, auth and realtime),
// PostHog when it is configured, YouTube for embedded players, and Stripe
// for the hosted checkout and billing pages. Images may come from any https
// host (article images, favicons, scraped pages under review). Styles allow
// inline: Tailwind's runtime values, TipTap and Next's font loader set them,
// and a style cannot run script.
//
// No form-action: the connector consent screen (app/oauth/authorize) answers
// its form with a redirect to whatever redirect URI the MCP client
// registered, custom schemes included, and browsers apply form-action to that
// redirect. The sanitiser drops <form> from content, so the directive would
// guard little and could break a sign-in.
//
// Pure: everything it needs is passed in, so the test can pin the policy.

export interface CspInput {
  nonce: string;
  /** NEXT_PUBLIC_SUPABASE_URL */
  supabaseUrl?: string | null;
  /** NEXT_PUBLIC_POSTHOG_HOST: absolute, or a same-origin proxy path. */
  posthogHost?: string | null;
  /** `next dev`: React's refresh runtime needs eval and the HMR socket. */
  dev?: boolean;
}

export const NONCE_HEADER = "x-nonce";

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** A fresh nonce: 16 random bytes, base64. */
export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function buildCsp({ nonce, supabaseUrl, posthogHost, dev = false }: CspInput): string {
  const supabase = originOf(supabaseUrl);
  const supabaseSocket = supabase ? supabase.replace(/^http/, "ws") : null;
  const posthog = originOf(posthogHost);

  const connect = ["'self'"];
  if (supabase) connect.push(supabase);
  if (supabaseSocket) connect.push(supabaseSocket);
  if (posthog) connect.push(posthog);
  // PostHog's ingestion and asset hosts (eu., us., *-assets.i.) when it is not proxied.
  if (posthog && /\.posthog\.com$/i.test(new URL(posthog).hostname)) connect.push("https://*.posthog.com");
  if (dev) connect.push("ws:", "wss:");

  const script = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (dev) script.push("'unsafe-eval'");

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": script,
    "style-src": ["'self'", "'unsafe-inline'"],
    // Supabase by origin too: a self-hosted or local stack serves storage over http.
    "img-src": ["'self'", "data:", "blob:", "https:", ...(supabase ? [supabase] : [])],
    "font-src": ["'self'", "data:"],
    "connect-src": connect,
    "media-src": ["'self'", "blob:", "data:", "https:", ...(supabase ? [supabase] : [])],
    "frame-src": [
      "'self'",
      "https://www.youtube-nocookie.com",
      "https://www.youtube.com",
      "https://js.stripe.com",
      "https://checkout.stripe.com",
      "https://billing.stripe.com",
    ],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "frame-ancestors": ["'none'"],
  };

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}
