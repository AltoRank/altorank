// ---------------------------------------------------------------------------
// Where a signup came from
// ---------------------------------------------------------------------------
//
// The marketing site adds these to a signup link at the moment it is clicked:
//
//   src     the path of the page the visitor clicked on ("/pricing/")
//   lp      the path of the first page they landed on in that visit
//           ("/alternatives/outrank/"), so a signup joins to the page that
//           earned it and not only to the one it was clicked on
//   ref     the external site that sent them, hostname only
//   utm_*   campaign params that were on the page's URL
//
// A visitor who reaches the app with none of that (an AI answer's link, a
// bookmark, a share page) still sends a Referer header: /signup and /signin
// fall back to its hostname for `ref` (refererHost below).
//
// /signup reads them from its URL, carries them through the form as hidden
// inputs (and through every error redirect, so a failed first submit does not
// lose them), and records them on the "account created" event. That makes them
// visible on /admin/events with no migration.
//
// Everything here comes from a URL anyone can type, so nothing is trusted: a
// value that is too long or has characters outside its expected shape is
// dropped, not repaired, and a bad value never blocks the signup. `from` is
// not read here. It is the tools signup's mode switch, not attribution.

import { MARKETING_URL } from "@/lib/constants";

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];

/** Every param this module reads and writes, in the order it writes them. */
export const SIGNUP_SOURCE_KEYS = ["src", "lp", "ref", ...UTM_KEYS] as const;
type SourceKey = (typeof SIGNUP_SOURCE_KEYS)[number];

export interface SignupSource {
  src?: string;
  lp?: string;
  ref?: string;
  utm?: Partial<Record<UtmKey, string>>;
}

export const MAX_SRC = 200;
export const MAX_REF = 120;
export const MAX_UTM = 100;

// A URL path as the marketing site builds them: a leading slash, then
// unreserved characters, slashes and percent-escapes.
const SRC_SHAPE = /^\/[A-Za-z0-9\-._~/%]*$/;
// A hostname: dot-separated labels of letters, digits and hyphens. IDNs arrive
// as punycode (xn--), which this covers.
const REF_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
// Campaign names are free text in practice ("spring sale", "lancio_città",
// "newsletter-2026-10"), so letters and digits in any script are allowed, with
// a few separators. Nothing that means something in HTML, a URL or a shell.
const UTM_SHAPE = /^[\p{L}\p{N} _.\-+~:/@|]+$/u;

function first(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" ? v : null;
}

function cleanSrc(value: string | null): string | undefined {
  const v = value?.trim();
  // "//host/..." passes the shape but is a protocol-relative URL, not a path.
  if (!v || v.length > MAX_SRC || !SRC_SHAPE.test(v) || v.startsWith("//")) return undefined;
  return v;
}

function cleanRef(value: string | null): string | undefined {
  const v = value?.trim().toLowerCase().replace(/\.$/, "");
  if (!v || v.length > MAX_REF || !REF_SHAPE.test(v)) return undefined;
  return v;
}

function cleanUtm(value: string | null): string | undefined {
  const v = value?.trim().replace(/\s+/g, " ");
  if (!v || v.length > MAX_UTM || !UTM_SHAPE.test(v)) return undefined;
  return v;
}

/**
 * Read the source params from a page's `searchParams` or a submitted form.
 * Returns only the values that pass their shape check; an empty object when
 * none do.
 */
export function parseSignupSource(input: FormData | Record<string, unknown> | null | undefined): SignupSource {
  if (!input) return {};
  const get = (key: SourceKey): string | null =>
    input instanceof FormData ? first(input.get(key)) : first((input as Record<string, unknown>)[key]);

  const out: SignupSource = {};
  const src = cleanSrc(get("src"));
  if (src) out.src = src;
  const lp = cleanSrc(get("lp"));
  if (lp) out.lp = lp;
  const ref = cleanRef(get("ref"));
  if (ref) out.ref = ref;
  const utm: Partial<Record<UtmKey, string>> = {};
  for (const key of UTM_KEYS) {
    const value = cleanUtm(get(key));
    if (value) utm[key] = value;
  }
  if (Object.keys(utm).length > 0) out.utm = utm;
  return out;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const MARKETING_HOST = hostOf(MARKETING_URL);

/**
 * The referring site's hostname from a request's Referer header, put through
 * the same check as a `ref` param. Undefined when there is no header, it does
 * not parse, or it names one of our own sites: the app itself (`requestHost`,
 * the request's Host header, or NEXT_PUBLIC_APP_URL) and the marketing site
 * and its subdomains. A visitor from the marketing site came through a link
 * that carries its own source, and one from another app page carries it in
 * the URL, so our own hostname would only hide that it is missing.
 */
export function refererHost(referer: string | null | undefined, requestHost?: string | null): string | undefined {
  const host = hostOf(referer);
  if (!host) return undefined;
  const own = [requestHost?.split(":")[0].toLowerCase(), hostOf(process.env.NEXT_PUBLIC_APP_URL)];
  if (own.includes(host)) return undefined;
  if (MARKETING_HOST && (host === MARKETING_HOST || host.endsWith(`.${MARKETING_HOST}`))) return undefined;
  return cleanRef(host);
}

/**
 * `source` with `ref` taken from the Referer header when the URL brought none.
 * For a page a visitor can reach straight from another site: an AI answer's
 * link to /signup, a share page, the connect flow's /signin.
 */
export function withRefererFallback(
  source: SignupSource,
  referer: string | null | undefined,
  requestHost?: string | null,
): SignupSource {
  if (source.ref) return source;
  const ref = refererHost(referer, requestHost);
  return ref ? { ...source, ref } : source;
}

/** The source as name/value pairs: one hidden input or one query param each. */
export function signupSourceFields(source: SignupSource): [SourceKey, string][] {
  const fields: [SourceKey, string][] = [];
  if (source.src) fields.push(["src", source.src]);
  if (source.lp) fields.push(["lp", source.lp]);
  if (source.ref) fields.push(["ref", source.ref]);
  for (const key of UTM_KEYS) {
    const value = source.utm?.[key];
    if (value) fields.push([key, value]);
  }
  return fields;
}

/**
 * The source as a query-string tail, `&src=…&ref=…`, for appending to a
 * redirect that already has a `?`. Empty when there is nothing to carry.
 */
export function signupSourceQuery(source: SignupSource): string {
  const fields = signupSourceFields(source);
  return fields.length ? `&${new URLSearchParams(fields).toString()}` : "";
}

/**
 * `path` with the source appended as query params, after any it already has.
 * For a link that has to hand the source on: /signin's "Sign up", /signup's
 * "Sign in".
 */
export function signupSourceHref(path: string, source: SignupSource): string {
  const fields = signupSourceFields(source);
  if (!fields.length) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams(fields).toString()}`;
}

/**
 * The shape recorded in an event's context: `{ src, lp, ref, utm }`, with `utm`
 * keyed by the part after `utm_` so the row reads `utm.source`, `utm.campaign`.
 * Keys with no value are left out rather than written as null.
 */
export function signupSourceContext(source: SignupSource): {
  src?: string;
  lp?: string;
  ref?: string;
  utm?: Record<string, string>;
} {
  const out: { src?: string; lp?: string; ref?: string; utm?: Record<string, string> } = {};
  if (source.src) out.src = source.src;
  if (source.lp) out.lp = source.lp;
  if (source.ref) out.ref = source.ref;
  if (source.utm) {
    const utm: Record<string, string> = {};
    for (const key of UTM_KEYS) {
      const value = source.utm[key];
      if (value) utm[key.slice(4)] = value;
    }
    if (Object.keys(utm).length > 0) out.utm = utm;
  }
  return out;
}

/**
 * One readable line for an event message:
 * "from /pricing/ (landed on /blog/x/) via news.ycombinator.com, utm_source newsletter".
 */
export function describeSignupSource(source: SignupSource): string {
  const parts: string[] = [];
  if (source.src) parts.push(`from ${source.src}`);
  if (source.lp && source.lp !== source.src) parts.push(`(landed on ${source.lp})`);
  if (source.ref) parts.push(`via ${source.ref}`);
  const head = parts.join(" ");
  const utm = UTM_KEYS.filter((k) => source.utm?.[k]).map((k) => `${k} ${source.utm![k]}`);
  const all = [head, ...utm].filter(Boolean).join(", ");
  return all || "source unknown";
}
