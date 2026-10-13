// ---------------------------------------------------------------------------
// Where a signup came from
// ---------------------------------------------------------------------------
//
// The marketing site adds these to a signup link at the moment it is clicked:
//
//   src     the path of the page the visitor clicked on ("/pricing/")
//   ref     the external site that sent them, hostname only
//   utm_*   campaign params that were on the page's URL
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

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];

/** Every param this module reads and writes, in the order it writes them. */
export const SIGNUP_SOURCE_KEYS = ["src", "ref", ...UTM_KEYS] as const;
type SourceKey = (typeof SIGNUP_SOURCE_KEYS)[number];

export interface SignupSource {
  src?: string;
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

/** The source as name/value pairs: one hidden input or one query param each. */
export function signupSourceFields(source: SignupSource): [SourceKey, string][] {
  const fields: [SourceKey, string][] = [];
  if (source.src) fields.push(["src", source.src]);
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
 * The shape recorded in an event's context: `{ src, ref, utm }`, with `utm`
 * keyed by the part after `utm_` so the row reads `utm.source`, `utm.campaign`.
 * Keys with no value are left out rather than written as null.
 */
export function signupSourceContext(source: SignupSource): {
  src?: string;
  ref?: string;
  utm?: Record<string, string>;
} {
  const out: { src?: string; ref?: string; utm?: Record<string, string> } = {};
  if (source.src) out.src = source.src;
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

/** One readable line for an event message: "from /pricing/ via news.ycombinator.com, utm_source newsletter". */
export function describeSignupSource(source: SignupSource): string {
  const parts: string[] = [];
  if (source.src) parts.push(`from ${source.src}`);
  if (source.ref) parts.push(`via ${source.ref}`);
  const head = parts.join(" ");
  const utm = UTM_KEYS.filter((k) => source.utm?.[k]).map((k) => `${k} ${source.utm![k]}`);
  const all = [head, ...utm].filter(Boolean).join(", ");
  return all || "source unknown";
}
