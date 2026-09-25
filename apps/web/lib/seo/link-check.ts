// ---------------------------------------------------------------------------
// Outbound link verification: does the page the writer cited exist?
// ---------------------------------------------------------------------------
//
// The brief tells the model to cite real, working URLs. A model produces
// plausible URLs, which is not the same thing, and nothing in the pipeline
// opened one. This does, once, right after generation: every outbound link is
// fetched, the answer is recorded against the article, and a link that is
// definitively dead is unwrapped to its text.
//
// "Definitively" is deliberate. A 404 or 410 to a GET, a host that does not
// resolve, or a server that refuses the connection is a dead citation and
// removing it is a service. A 401, 403, 405, 429, 451 or 999, a 5xx, a
// Cloudflare or Akamai challenge page or a timeout is a server that did not
// want to talk to a bot from a data centre right now, and a real source behind
// a WAF looks exactly like that. Those are kept and recorded as unverified,
// for a person to open. Stripping them would remove exactly the authoritative
// sources that are most likely to be behind one.
//
// A real signup, 2026-09-22 (Turkish web/mobile agency): the checker deleted a
// valid Google Play source from his draft. It removed only 404, 410 and
// unresolvable hosts, so Play answered one of those - and a HEAD-only 404 was
// taken as final, and Play answers 404 for a listing that is not distributed
// in the country the request comes from, which a check run from one data
// centre cannot tell from a missing app. So: a HEAD is never the last word
// (anything but a 2xx/3xx to HEAD is asked again with GET), and a 404 from a
// catalogue that scopes listings by country is recorded as unverified.
//
// Every request goes through the SSRF-safe fetcher the public tools use
// (lib/public-tools/safe-fetch.ts): a URL a model wrote is not one our server
// should open without checking where its name resolves.
//
// No API cost. HTTP only, bounded by concurrency and a per-request timeout.

import { extractLinks, hostOf, type LinkRef } from "./links";
import { safeFetch, UnsafeUrlError, type SafeFetch } from "@/lib/public-tools/safe-fetch";

/**
 * live: the page answered. dead: definitively gone, and unwrapped.
 * unverified: kept - something stood between us and the page - for a person
 * to open.
 */
export type LinkVerdict = "live" | "dead" | "unverified";

export interface LinkCheck {
  url: string;
  /** HTTP status, or null when no response came back. */
  status: number | null;
  /** The page answered 2xx or 3xx, and not with a bot challenge. */
  ok: boolean;
  /**
   * What the answer means. Optional only because rows stored before
   * 2026-09-25 lack it; `ok` and `removed` still say the same thing for those.
   */
  verdict?: LinkVerdict;
  /** Why it is not ok, in words a reviewer can act on. */
  reason?: string;
  /** Unwrapped from the article because it was definitively dead. */
  removed: boolean;
  checkedAt: string;
}

/** One answer from a server, as much of it as the classification reads. */
export interface LinkResponse {
  status: number;
  /** Lower-cased names. */
  headers?: Record<string, string>;
  /** The start of the body, when one was read: a challenge page is recognised by it. */
  body?: string;
  /**
   * The method that produced the answer. A fetcher that confirms a failing
   * HEAD with a GET (the default does) returns the GET's answer; only a
   * fetcher that never does says "HEAD", and its 404 is not taken as final.
   */
  method?: "HEAD" | "GET";
}

export type LinkFetcher = (url: string) => Promise<LinkResponse>;

export interface VerifyOptions {
  fetcher?: LinkFetcher;
  concurrency?: number;
  timeoutMs?: number;
  now?: () => Date;
}

const UA =
  "Mozilla/5.0 (compatible; AltoRank-LinkCheck/1.0; +https://altorank.co; citation check)";

/** Statuses that mean the resource is gone, not merely guarded. */
const DEAD_STATUSES = new Set([404, 410]);
/**
 * Catalogues that show a listing only to the countries it is distributed in
 * and answer 404 everywhere else. The check runs from one data centre, so a
 * 404 here says "not sold where we asked from", not "gone". Google Play is
 * the one the 2026-09-22 draft cited; add a host only with the same evidence.
 */
export const COUNTRY_SCOPED_HOSTS: ReadonlySet<string> = new Set(["play.google.com"]);

/**
 * The challenge page a bot manager serves instead of the page, by vendor, or
 * null. Its status is often 403 or 503 but can be 200 or even 404, so the
 * status alone cannot be trusted to say what the page is.
 */
export function botChallengeOf(headers: Record<string, string> = {}, body = ""): string | null {
  const h = (name: string) => (headers[name] ?? "").toLowerCase();
  const head = body.slice(0, 20_000);
  if (h("cf-mitigated") === "challenge") return "Cloudflare";
  if (/<title>\s*(?:just a moment|attention required!? \| cloudflare)/i.test(head) || /cf-chl-|challenge-platform|cf-browser-verification/i.test(head)) {
    return "Cloudflare";
  }
  if (h("server").includes("akamaighost") && /access denied/i.test(head)) return "Akamai";
  if (/errors\.edgesuite\.net|<title>\s*access denied\s*<\/title>[\s\S]{0,2000}reference(?:&#32;|\s)#/i.test(head)) return "Akamai";
  if (h("x-datadome") || /captcha-delivery\.com/i.test(head)) return "DataDome";
  if (/<title>\s*pardon our interruption/i.test(head) || /_incapsula_resource|incap_ses_/i.test(head)) return "Imperva";
  if (/px-captcha|_pxappid/i.test(head)) return "PerimeterX";
  if (/<title>\s*(?:robot check|are you a robot|verify you are human)/i.test(head)) return "a bot check";
  return null;
}

/**
 * What one answer means for a citation. Pure, so the policy is testable
 * without a network: the whole difference between "remove" and "keep and
 * ask a person" is decided here.
 */
export function classifyLinkResponse(url: string, res: LinkResponse): { verdict: LinkVerdict; reason?: string } {
  const { status } = res;
  const challenge = botChallengeOf(res.headers, res.body);
  if (challenge) return { verdict: "unverified", reason: `HTTP ${status}, a ${challenge} challenge page; could not verify` };
  if (status >= 200 && status < 400) return { verdict: "live" };
  if (DEAD_STATUSES.has(status)) {
    if (res.method === "HEAD") return { verdict: "unverified", reason: `HTTP ${status} to HEAD, not confirmed with GET` };
    const host = hostOf(url);
    if (host && COUNTRY_SCOPED_HOSTS.has(host)) {
      return { verdict: "unverified", reason: `HTTP ${status}; this store hides listings from countries they are not sold in, could not verify` };
    }
    return { verdict: "dead", reason: `HTTP ${status}, page gone` };
  }
  // Everything else is kept. 401, 403, 405, 429, 451 and 999 (LinkedIn's
  // answer to anything that is not a browser) are a bot rule, a login wall or
  // a rate limit in front of a page that may be perfectly real; a 5xx is the
  // server having a bad minute; any other 4xx is not the page saying "gone".
  return { verdict: "unverified", reason: `HTTP ${status}, could not verify` };
}

/**
 * What a fetch that never got an answer means. Only a name that does not
 * exist and a server that refuses the connection are definitive; a timeout,
 * a reset or a temporary DNS failure is the network, not the page.
 */
export function classifyLinkError(err: unknown): { verdict: LinkVerdict; reason: string } {
  if (err instanceof UnsafeUrlError) {
    return /private or local address/i.test(err.message)
      ? { verdict: "dead", reason: "not a public host" }
      : { verdict: "unverified", reason: `not checked: ${err.message}` };
  }
  const reason = describe(err);
  return { verdict: reason === "host not found" || reason === "connection refused" ? "dead" : "unverified", reason };
}

/**
 * Hosts a server-side fetch must never be pointed at on the strength of a
 * model's output: loopback, link-local, private ranges, bare IP literals and
 * internal TLDs. A link to any of these is removed without being fetched.
 */
export function isUnsafeHost(url: string): boolean {
  const host = hostOf(url);
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/\.(?:local|internal|lan|home|corp|intranet)$/i.test(host)) return true;
  if (/^\[?[0-9a-f:]+\]?$/i.test(host) && host.includes(":")) return true; // IPv6 literal
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return true; // any other bare IPv4 is not a citation either
  }
  return false;
}

/** Enough of a body to recognise a challenge page; the page itself is not needed. */
const BODY_BYTES = 64_000;

/**
 * HEAD first, because it is cheap for both sides; GET whenever HEAD says
 * anything but "here". Servers that mishandle HEAD answer it 404, 405 or 403
 * while serving the page to a GET, and a reader follows a link with a GET.
 * A name that does not resolve is not asked twice: DNS does not care about
 * the method.
 */
export const defaultFetcher = (timeoutMs: number, fetchImpl: SafeFetch = safeFetch): LinkFetcher => async (url) => {
  const opts = { timeoutMs, userAgent: UA, maxBytes: BODY_BYTES };
  try {
    const head = await fetchImpl(url, { ...opts, method: "HEAD" });
    if (head.status >= 200 && head.status < 400 && !botChallengeOf(head.headers)) {
      return { status: head.status, headers: head.headers, method: "HEAD" };
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError || classifyLinkError(err).reason === "host not found") throw err;
  }
  const get = await fetchImpl(url, { ...opts, method: "GET" });
  return { status: get.status, headers: get.headers, body: get.body, method: "GET" };
};

function describe(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "AbortError" || e?.name === "TimeoutError" || /timed out/i.test(e?.message ?? "")) return "timed out";
  const code = e?.cause?.code;
  if (code === "ENOTFOUND") return "host not found";
  if (code === "ECONNREFUSED") return "connection refused";
  if (code) return code;
  return e?.message ?? "fetch failed";
}

/**
 * Fetch every outbound link in `html` once, unwrap the definitively dead ones,
 * and return the HTML plus one record per distinct URL.
 */
export async function verifyOutboundLinks(
  html: string,
  siteDomain: string | null | undefined,
  opts: VerifyOptions = {},
): Promise<{ html: string; checks: LinkCheck[] }> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const fetcher = opts.fetcher ?? defaultFetcher(timeoutMs);
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const now = opts.now ?? (() => new Date());

  const external = extractLinks(html, siteDomain).filter((l): l is LinkRef => l.kind === "external");
  const urls = [...new Set(external.map((l) => l.href))];
  if (urls.length === 0) return { html, checks: [] };

  const checks: LinkCheck[] = [];
  const check = async (url: string): Promise<void> => {
    const checkedAt = now().toISOString();
    if (isUnsafeHost(url)) {
      checks.push({ url, status: null, ok: false, verdict: "dead", reason: "not a public host", removed: true, checkedAt });
      return;
    }
    try {
      const res = await fetcher(url);
      const { verdict, reason } = classifyLinkResponse(url, res);
      checks.push({
        url,
        status: res.status,
        ok: verdict === "live",
        verdict,
        reason,
        removed: verdict === "dead",
        checkedAt,
      });
    } catch (err) {
      // A host that does not exist, or refuses the connection, is dead.
      // Everything else is unknown.
      const { verdict, reason } = classifyLinkError(err);
      checks.push({ url, status: null, ok: false, verdict, reason, removed: verdict === "dead", checkedAt });
    }
  };

  // Bounded parallelism without a dependency: a shared queue and N workers.
  const queue = [...urls];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) await check(queue.shift()!);
    }),
  );

  const removed = new Set(checks.filter((c) => c.removed).map((c) => c.url));
  const cleaned = removed.size ? unwrap(html, siteDomain, removed) : html;
  // Stable order for storage and display: as they appear in the article.
  const order = new Map(urls.map((u, i) => [u, i]));
  checks.sort((a, b) => (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0));
  return { html: cleaned, checks };
}

/** Replace each anchor whose (decoded) href is in `urls` with its inner text. */
function unwrap(html: string, siteDomain: string | null | undefined, urls: Set<string>): string {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs: string, inner: string) => {
    const [ref] = extractLinks(`<a${attrs}>x</a>`, siteDomain);
    return ref && urls.has(ref.href) ? inner : full;
  });
}
