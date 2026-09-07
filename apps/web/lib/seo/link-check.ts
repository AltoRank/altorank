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
// "Definitively" is deliberate. A 404 or 410, or a host that does not resolve,
// is a dead citation and removing it is a service. A 403, a 429, a 5xx or a
// timeout is a server that did not want to talk to a bot from a data centre
// right now, and a real source behind a WAF looks exactly like that. Those are
// kept and reported as unverified, for a person to open. Stripping them would
// remove exactly the authoritative sources that are most likely to be behind
// one.
//
// No API cost. HTTP only, bounded by concurrency and a per-request timeout.

import { extractLinks, hostOf, type LinkRef } from "./links";

export interface LinkCheck {
  url: string;
  /** HTTP status, or null when no response came back. */
  status: number | null;
  /** The page answered 2xx or 3xx. */
  ok: boolean;
  /** Why it is not ok, in words a reviewer can act on. */
  reason?: string;
  /** Unwrapped from the article because it was definitively dead. */
  removed: boolean;
  checkedAt: string;
}

export type LinkFetcher = (url: string) => Promise<{ status: number; finalUrl?: string }>;

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
/** Servers that refuse HEAD but answer GET. */
const RETRY_WITH_GET = new Set([405, 403, 501]);

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

export const defaultFetcher = (timeoutMs: number): LinkFetcher => async (url) => {
  const attempt = async (method: "HEAD" | "GET") => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" },
      });
      // Drain nothing: a GET body is not needed, and closing early is fine.
      if (method === "GET") void res.body?.cancel().catch(() => undefined);
      // `res.url` is where we ended up, which is not always where we asked to
      // go. A citation that 301s to a section index is a soft 404: status 200,
      // and none of the claim it was cited for. See `redirectedToIndex`.
      return { status: res.status, finalUrl: res.url || undefined };
    } finally {
      clearTimeout(timer);
    }
  };
  const head = await attempt("HEAD");
  return RETRY_WITH_GET.has(head.status) ? attempt("GET") : head;
};

/**
 * True when a redirect landed on an ancestor of what was asked for - the shape
 * a site uses when a page is retired: `/research/what-is-cvc/` -> `/research/`.
 * The status is 200 and the link "works", but the claim it was cited for is
 * not on the page that answered. A redirect that keeps the same depth (http to
 * https, a trailing slash, a locale prefix, a renamed slug) is not this.
 */
export function redirectedToIndex(requested: string, finalUrl: string | undefined): boolean {
  if (!finalUrl) return false;
  let from: URL, to: URL;
  try {
    from = new URL(requested);
    to = new URL(finalUrl);
  } catch {
    return false;
  }
  const segs = (u: URL) => u.pathname.split("/").filter(Boolean);
  const a = segs(from);
  const b = segs(to);
  // Only shrinking counts, and only when what is left is a prefix of what was
  // asked for. `/a/b/c` -> `/a` is an index; `/a/b/c` -> `/a/b/d` is a rename.
  if (b.length >= a.length) return false;
  return b.every((seg, i) => seg === a[i]);
}

function describe(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "AbortError") return "timed out";
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
      checks.push({ url, status: null, ok: false, reason: "not a public host", removed: true, checkedAt });
      return;
    }
    try {
      const { status, finalUrl } = await fetcher(url);
      const soft404 = status >= 200 && status < 400 && redirectedToIndex(url, finalUrl);
      const ok = status >= 200 && status < 400 && !soft404;
      checks.push({
        url,
        status,
        ok,
        reason: ok
          ? undefined
          : soft404
            ? `redirected to ${finalUrl}, which is not the page cited`
            : DEAD_STATUSES.has(status)
              ? `HTTP ${status}, page gone`
              : `HTTP ${status}, could not verify`,
        // NOT unwrapped. A dead link is noise; a link that resolves to the
        // wrong page is a claim to re-check, and unwrapping it would leave the
        // sentence asserting the same thing with nothing attached at all. The
        // reviewer sees `ok: false` and the reason in the audit tab.
        removed: DEAD_STATUSES.has(status),
        checkedAt,
      });
    } catch (err) {
      const reason = describe(err);
      checks.push({
        url,
        status: null,
        ok: false,
        reason,
        // A host that does not exist is dead. Everything else is unknown.
        removed: reason === "host not found",
        checkedAt,
      });
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
