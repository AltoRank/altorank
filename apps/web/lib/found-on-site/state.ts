// ---------------------------------------------------------------------------
// "Live on your site": how a found article reads in the product
// ---------------------------------------------------------------------------
//
// An article the nightly check found on the customer's own site is `live`
// like any published article - that is what makes it count - but it did not
// go through us, and the product says so: a different label wherever the
// status is shown, the page it was found on, what the comparison measured,
// and a way to say "that is not my article".
//
// Pure and import-free on purpose: the editor and the list are client
// components, and nothing here may pull the server half of lib/found-on-site
// into their bundle.

/** The label for an article found live on the customer's site, in place of "Live". */
export const LIVE_ON_YOUR_SITE = "Live on your site";

export interface FoundOnSiteFields {
  status: string;
  published_url: string | null;
  found_on_site_at?: string | null;
  found_on_site_evidence?: unknown;
}

export interface FoundOnSiteView {
  url: string;
  foundAt: string;
  /** Share of the draft's text found on the page, 0-100, or null when the evidence did not record it. */
  textPercent: number | null;
  /** How the match was decided, in words a person can check. */
  basis: string;
}

/** Whether this article is live because we found it on the site, as opposed to because we published it. */
export function isFoundOnSite(a: FoundOnSiteFields): boolean {
  return a.status === "live" && Boolean(a.found_on_site_at) && Boolean(a.published_url);
}

/** The pill label: "Live on your site" for a find, the default for everything else. */
export function liveLabel(a: FoundOnSiteFields): string | undefined {
  return isFoundOnSite(a) ? LIVE_ON_YOUR_SITE : undefined;
}

/** What the editor shows about a find, or null when the article was not found on the site. */
export function foundOnSiteView(a: FoundOnSiteFields): FoundOnSiteView | null {
  if (!isFoundOnSite(a)) return null;
  const e = (a.found_on_site_evidence ?? {}) as { containment?: unknown; title?: unknown; rule?: unknown };
  const containment = typeof e.containment === "number" ? e.containment : null;
  const textPercent = containment === null ? null : Math.round(containment * 100);
  // Runs of four words, matched exactly: "word for word" is what was measured.
  // With no measurement on the row, say that rather than imply all of it.
  const basis =
    textPercent === null
      ? "The draft's text was found on that page; how much of it was not recorded"
      : `${textPercent}% of the draft's text appears on that page word for word${e.rule === "text+title" ? ", under the same headline" : ""}`;
  return { url: a.published_url!, foundAt: a.found_on_site_at!, textPercent, basis };
}

/**
 * Why the nightly check cannot see new pages on a site, as stored on
 * `workspaces.found_on_site_unreadable` (migration 094). A code, so the words
 * live here, once.
 */
export type FoundOnSiteBlindness =
  | "robots-unanswered"
  | "robots-disallowed"
  | "no-sitemap"
  | "empty-sitemap"
  | "javascript";

/** The end of "We can't see new pages on acme.example: ...". */
export const BLIND_REASON: Record<FoundOnSiteBlindness, string> = {
  "robots-unanswered": "its robots.txt did not answer, and a site that cannot say what it allows is not read",
  "robots-disallowed": "its robots.txt does not allow our crawler to read its pages",
  "no-sitemap": "it has no sitemap we could read, so there is no list of new pages to check",
  "empty-sitemap": "its sitemap lists no pages on this site",
  javascript: "its pages load their text with JavaScript, which our check does not run",
};

export interface BlindFields {
  domain: string;
  found_on_site_unreadable?: string | null;
  found_on_site_checked_at?: string | null;
}

/**
 * The Publish panel's warning for a site the check cannot see, or null when
 * it can (or has not looked yet). Said where a person without a connected CMS
 * is about to copy the draft out: an article they publish there by hand will
 * not be noticed, and the product says so rather than letting "not published"
 * stand as a silent guess.
 */
export function blindNote(ws: BlindFields, articleStatus: string): string | null {
  const code = ws.found_on_site_unreadable as FoundOnSiteBlindness | null | undefined;
  if (!code) return null;
  // A code this build does not know still means the check could not see the
  // site; say that much rather than nothing.
  const reason = BLIND_REASON[code] ?? "our nightly check could not read it";
  const when = ws.found_on_site_checked_at
    ? ` (checked ${new Date(ws.found_on_site_checked_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })})`
    : "";
  const next =
    articleStatus === "approved"
      ? "If you publish this article there yourself, paste its address below once it is live, or it will not count as published."
      : "If you publish this article there yourself, we will not notice on our own: once it is approved, paste its address here.";
  return `We can't see new pages on ${ws.domain}${when}: ${reason}. ${next}`;
}

export interface ArticleTally {
  total: number;
  /** Live by any route: published through AltoRank, recorded by hand, or found on the site. */
  live: number;
  /** Of `live`, the ones the nightly check found on the customer's site. */
  foundOnSite: number;
}

/**
 * Articles per workspace, with how many are live and how many of those were
 * found on the site. For the operator's view of who is actually using drafts:
 * the incident this exists for read as "0 published" everywhere while the
 * customer's copy was on the web.
 */
export function tallyArticles(
  rows: ReadonlyArray<{ workspace_id: string; status: string; found_on_site_at?: string | null }>,
): Map<string, ArticleTally> {
  const out = new Map<string, ArticleTally>();
  for (const r of rows) {
    const t = out.get(r.workspace_id) ?? { total: 0, live: 0, foundOnSite: 0 };
    t.total += 1;
    if (r.status === "live") {
      t.live += 1;
      if (r.found_on_site_at) t.foundOnSite += 1;
    }
    out.set(r.workspace_id, t);
  }
  return out;
}
