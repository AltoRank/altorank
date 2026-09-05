// ---------------------------------------------------------------------------
// Where a link goes: the one classifier every scorer shares
// ---------------------------------------------------------------------------
//
// Three modules used to decide this independently and all three got it wrong
// in a different direction. `scoring.ts` called anything not on five named
// social hosts "internal", so a HubSpot citation passed the internal-link
// check. `aeo-scoring.ts` called every absolute URL "outbound", so the site's
// own resolved links counted as citations. The Tiptap converter marked every
// link nofollow. None of them knew the site's domain, and without it the
// question has no answer.
//
// This module is told the domain and answers once. It lives on its own rather
// than inside `article-audit.ts` because the audit imports the AEO scorer, and
// the scorer importing the audit back would be a cycle.

import { decodeEntities } from "@/lib/audit/html-utils";

export type LinkKind =
  /** Points at this site: a relative path, or an absolute URL on its domain. */
  | "internal"
  /** Points somewhere else on the web. */
  | "external"
  /** In-page anchor (`#section`), or mailto:/tel:. Neither a page nor a citation. */
  | "anchor"
  /** `href="#"`, empty, or javascript:. Looks clickable, goes nowhere. */
  | "dead"
  /** `{{internal-link:…}}` the resolver never replaced. */
  | "placeholder";

export interface LinkRef {
  href: string;
  anchor: string;
  kind: LinkKind;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * A workspace domain as people type it ("https://www.Example.com/") reduced to
 * the bare host classification compares against. Idempotent, so a caller may
 * normalise early or leave it to `classifyHref`.
 */
export function normaliseDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return null;
  const host = hostOf(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  return (host ?? trimmed.split("/")[0]).replace(/^www\./, "") || null;
}

/**
 * Classify one href. With no `siteDomain`, every absolute URL is external:
 * an unknown site cannot claim a URL as its own.
 */
export function classifyHref(href: string, siteDomain: string | null | undefined): LinkKind {
  if (href.includes("{{internal-link")) return "placeholder";
  if (href === "" || href === "#" || /^javascript:/i.test(href)) return "dead";
  if (href.startsWith("#")) return "anchor";
  if (/^https?:\/\//i.test(href)) {
    const host = hostOf(href);
    const site = normaliseDomain(siteDomain);
    if (host && site && (host === site || host.endsWith(`.${site}`))) return "internal";
    return "external";
  }
  if (/^(?:mailto|tel|sms):/i.test(href)) return "anchor";
  // Relative paths and bare slugs point at this site.
  return "internal";
}

/** Every `<a>` in `html`, with its decoded href and visible text. */
export function extractLinks(html: string, siteDomain: string | null | undefined): LinkRef[] {
  const out: LinkRef[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>/gi)) {
    // The anchor's text runs to its closing tag or to the next `<a`, whichever
    // comes first. A browser closes an anchor where another opens inside it;
    // matching `<a>…</a>` lazily instead swallowed the nested tag as body text,
    // so a draft with three links counted two (linking track, 2026-09-04).
    const rest = html.slice((m.index ?? 0) + m[0].length);
    const end = rest.search(/<\/a\s*>|<a\b/i);
    const body = end === -1 ? rest : rest.slice(0, end);
    const hrefMatch = m[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    // The editor escapes `&` as `&amp;` inside attributes too, so decode
    // before classifying or the URL that opens is not the one the text held.
    const href = decodeEntities(hrefMatch?.[1] ?? hrefMatch?.[2] ?? "").trim();
    const anchor = decodeEntities(body.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    out.push({ href, anchor, kind: classifyHref(href, siteDomain) });
  }
  return out;
}

/** The hrefs of every `<a>` in a fragment, undecoded, for cheap counting. */
export function hrefsIn(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(
    (m) => (m[1] ?? m[2] ?? "").trim(),
  );
}

/**
 * Whether an href counts as a citation: a link to somewhere other than this
 * site. Without a domain every absolute URL qualifies, which is the most the
 * scorer can honestly claim when it does not know whose page it is reading.
 */
export function isCitationLink(href: string, siteDomain: string | null | undefined): boolean {
  return classifyHref(href, siteDomain) === "external";
}

// ---------------------------------------------------------------------------
// Is this internal link a page we know?
// ---------------------------------------------------------------------------
//
// "Internal" says where a link points. It does not say the page exists. The
// writer is told which pages do (the link pool: configured targets, our own
// live articles, the crawl) and told to link to those only, and it links to
// `/guides/founder-equity-splits` anyway when the subject deserved a pointer
// and nothing on the list fit. A same-domain URL nobody has observed is a
// 404 with the customer's name on it, so every reader of a draft asks the
// same question here: the resolver that unwraps it, the scorer that would
// otherwise count it, the audit, and the editor panel that names it.

/**
 * One URL on this site reduced to the form two links to the same page compare
 * equal under: host without `www.`, path without a trailing slash, no query
 * or hash. A relative href resolves against the site domain.
 */
export function normaliseSiteUrl(href: string, siteDomain: string | null | undefined): string {
  const site = normaliseDomain(siteDomain);
  try {
    const u = new URL(href.trim(), site ? `https://${site}` : "https://invalid.local");
    u.hash = "";
    u.search = "";
    return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return href.trim().replace(/\/+$/, "").toLowerCase();
  }
}

/** The known page `href` points at, or null when it points at none of them. */
export function findKnownPage<T extends { url: string }>(
  href: string,
  siteDomain: string | null | undefined,
  pages: readonly T[],
): T | null {
  const want = normaliseSiteUrl(href, siteDomain);
  for (const p of pages) {
    if (normaliseSiteUrl(p.url, siteDomain) === want) return p;
  }
  return null;
}

/** Whether `href` is the site's root: `https://example.com/`, `/`, or the bare domain. */
export function isSiteRoot(href: string, siteDomain: string | null | undefined): boolean {
  const site = normaliseDomain(siteDomain);
  return Boolean(site) && normaliseSiteUrl(href, siteDomain) === site;
}

/**
 * Whether an internal `href` points at a page we can show exists: one of
 * `pages`, or the site's own root. The root is the one page whose existence
 * the workspace itself asserts, and the closing call to action links to it.
 */
export function isKnownPage(
  href: string,
  siteDomain: string | null | undefined,
  pages: readonly { url: string }[],
): boolean {
  return isSiteRoot(href, siteDomain) || findKnownPage(href, siteDomain, pages) !== null;
}
