// ---------------------------------------------------------------------------
// Which of a site's pages are worth reading tonight
// ---------------------------------------------------------------------------
//
// A sitemap can list thousands of pages; the check reads twenty. Which twenty
// is decided here, with no I/O, so the rules are testable one by one.
//
// A page is compared with a draft only when it is NEW relative to that draft,
// because a page that existed before the draft was written cannot be a copy
// of it (and a content-refresh draft is, by design, very like a page that
// already exists). "New" is decided on the best evidence the site gives:
//
//   lastmod     the sitemap's date for the page is no earlier than a day
//               before the draft was created. A day, because many sitemaps
//               carry a date with no time, which parses as midnight UTC.
//   first seen  the weekly crawl first saw the page after the draft was
//               created (`site_pages.first_seen_at`). This counts even when
//               a lastmod says the page is older: a hand-written sitemap
//               often carries a date copied from another entry, or never
//               updated, and the crawl's own first sighting is a fact we
//               observed.
//   seen before a page the crawl already knew before the draft goes by its
//               lastmod alone, like any dated page: new only when the
//               lastmod moved after the draft. That is deliberate. Pasting
//               a draft over an existing page is one of the ways a draft
//               ends up on a site, and a page that changed after the draft
//               existed is exactly the one to read; a page that did not
//               change stays old.
//   neither     with no lastmod, a page the crawl has never seen is new; with
//               a lastmod, it is new only if the lastmod says so.
//
// And only when it has not already been compared: the ledger
// (`found_on_site_checks`, migration 094) records every page read. A page read
// before is read again only when its lastmod moved past the read - the page
// changed, possibly into our draft. Without a lastmod there is no way to know
// it changed, and it is not re-read; that is a stated limit, not a guess.
//
// Order, when more pages qualify than the cap allows: never-read before
// re-reads, dated before undated, newest first. Whatever the cap cuts is
// counted and reported, and is first in line the next night because the pages
// read tonight drop out of the queue.

import { NOT_CONTENT } from "@/lib/seo/site-crawl";
import type { SitemapEntry } from "@/lib/seo/sitemap";

/** Pages read per workspace per night. */
export const PAGES_PER_WORKSPACE = 20;

/** Slack on a lastmod, for date-only values and clocks that disagree. */
export const LASTMOD_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * One URL as a comparison key: host lower-cased without `www.`, no fragment,
 * no trailing slash, scheme ignored. A sitemap, the crawl and a published_url
 * written by an adapter can spell one page three ways.
 */
export function urlKey(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** The site's host from a workspace domain as stored ("acme.example", "https://www.acme.example/"). */
export function siteHost(domain: string): string {
  const d = domain.trim().toLowerCase();
  try {
    return new URL(d.startsWith("http") ? d : `https://${d}`).hostname.replace(/^www\./, "");
  } catch {
    return d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  }
}

/** On the customer's site: the host itself or a subdomain of it (a blog.acme.example counts). */
export function onSite(url: string, host: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return h === host || h.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

export interface CandidateDraft {
  id: string;
  createdAt: string;
  /** URLs a person said are not this article. Never matched to it again. */
  rejected: readonly string[];
}

export interface LedgerRow {
  checkedAt: string;
}

export interface SelectInput {
  entries: readonly SitemapEntry[];
  drafts: readonly CandidateDraft[];
  host: string;
  /** robots.txt, already loaded. */
  allowed: (url: string) => boolean;
  /** site_pages: url key -> first_seen_at. */
  known: ReadonlyMap<string, string>;
  /** found_on_site_checks: url key -> the last read. */
  ledger: ReadonlyMap<string, LedgerRow>;
  /** Keys of URLs that are already some article's published_url on this workspace. */
  claimed: ReadonlySet<string>;
  limit?: number;
}

export interface Candidate {
  url: string;
  lastmod: string | null;
  /** The drafts this page is new relative to and has not been compared with. */
  draftIds: string[];
  /** Read before, and read again because its lastmod moved. */
  reread: boolean;
}

export interface Selection {
  chosen: Candidate[];
  /** Why every other sitemap URL was not read, as counts. */
  skipped: {
    offSite: number;
    notContent: number;
    disallowed: number;
    alreadyAnArticle: number;
    notNew: number;
    alreadyRead: number;
    overCap: number;
  };
}

export function selectCandidates(input: SelectInput): Selection {
  const limit = input.limit ?? PAGES_PER_WORKSPACE;
  const skipped: Selection["skipped"] = {
    offSite: 0, notContent: 0, disallowed: 0, alreadyAnArticle: 0, notNew: 0, alreadyRead: 0, overCap: 0,
  };
  const eligible: Array<Candidate & { order: number; known: boolean }> = [];

  input.entries.forEach((entry, order) => {
    const url = entry.loc;
    if (!onSite(url, input.host)) return void skipped.offSite++;
    if (NOT_CONTENT.test(url)) return void skipped.notContent++;
    const key = urlKey(url);
    if (input.claimed.has(key)) return void skipped.alreadyAnArticle++;
    if (!input.allowed(url)) return void skipped.disallowed++;

    const lastmod = entry.lastmod ? Date.parse(entry.lastmod) : NaN;
    const firstSeen = input.known.get(key);
    const read = input.ledger.get(key);
    let isNewForSome = false;
    const draftIds: string[] = [];
    for (const d of input.drafts) {
      if (d.rejected.some((r) => urlKey(r) === key)) continue;
      const created = Date.parse(d.createdAt);
      const seenAfter = firstSeen !== undefined && Date.parse(firstSeen) >= created;
      const isNew = Number.isFinite(lastmod)
        ? lastmod >= created - LASTMOD_SLACK_MS || seenAfter
        : firstSeen === undefined || seenAfter;
      if (!isNew) continue;
      isNewForSome = true;
      // Read before: only again if the page changed after that read, which
      // only a lastmod can say.
      const needs = !read || (Number.isFinite(lastmod) && lastmod > Date.parse(read.checkedAt));
      if (needs) draftIds.push(d.id);
    }
    if (!isNewForSome) return void skipped.notNew++;
    if (!draftIds.length) return void skipped.alreadyRead++;
    eligible.push({ url, lastmod: entry.lastmod, draftIds, reread: Boolean(read), order, known: firstSeen !== undefined });
  });

  eligible.sort((a, b) => {
    if (a.reread !== b.reread) return a.reread ? 1 : -1;
    if (Boolean(a.lastmod) !== Boolean(b.lastmod)) return a.lastmod ? -1 : 1;
    if (a.lastmod && b.lastmod && a.lastmod !== b.lastmod) return b.lastmod.localeCompare(a.lastmod);
    if (a.known !== b.known) return a.known ? 1 : -1;
    return a.order - b.order;
  });

  skipped.overCap = Math.max(0, eligible.length - limit);
  return {
    chosen: eligible.slice(0, limit).map(({ url, lastmod, draftIds, reread }) => ({ url, lastmod, draftIds, reread })),
    skipped,
  };
}
