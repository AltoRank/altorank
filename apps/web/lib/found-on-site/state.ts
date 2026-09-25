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
