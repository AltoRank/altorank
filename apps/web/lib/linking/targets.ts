import type { SupabaseClient } from "@supabase/supabase-js";
import type { LinkTarget } from "@/lib/seo/link-resolver";

// ---------------------------------------------------------------------------
// The link pool a draft is offered
// ---------------------------------------------------------------------------
//
// Three places know about a site's pages, and a draft should be able to link
// to any of them:
//
//   link_targets   the configured pool: detected from the sources on
//                  /linking, or typed in, with a priority and preferred
//                  anchors. The only one a person has shaped.
//   articles       what AltoRank wrote and published, with the URL recorded.
//   site_pages     what the crawl read from the customer's own sitemap.
//
// One list comes out, ranked so that the twenty the prompt shows are the
// twenty most worth linking to for THIS article: priority first, because a
// person set it; then how much the page's subject overlaps the keyword being
// written about; then our own live articles ahead of pages we merely read.
// Same URL from two places is one entry, and the pool row wins because it is
// the one carrying anchors and priority.

/** A row of `link_targets`, as the ranking reads it. */
export interface PoolTarget {
  url: string;
  title: string | null;
  keyword: string | null;
  priority: number;
  anchors: string[];
}

export interface RankInput {
  pool: PoolTarget[];
  /** Live articles first, then crawled pages: the order `fetchPublishedTargets` returns. */
  published: LinkTarget[];
  /** The keyword the draft is about. Undefined ranks by priority and origin only. */
  keyword?: string | null;
  limit?: number;
}

/** The prompt shows this many; more is a longer list the model reads less of. */
export const DEFAULT_LIMIT = 20;

function normaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return url.trim().replace(/\/+$/, "").toLowerCase();
  }
}

function tokens(text: string | null | undefined): Set<string> {
  return new Set(
    (text ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Words the topic shares with the target's keyword and title, over the topic's words. */
export function relevance(keyword: string | null | undefined, target: { keyword: string; title: string }): number {
  const want = tokens(keyword);
  if (want.size === 0) return 0;
  const have = new Set([...tokens(target.keyword), ...tokens(target.title)]);
  let hits = 0;
  for (const w of want) if (have.has(w)) hits++;
  return hits / want.size;
}

/** Slug words, for a pool row the crawl never titled. Better than an empty string in a prompt. */
function wordsFromPath(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return last.replace(/\.(html?|php|aspx?)$/, "").replace(/[-_]+/g, " ").trim();
  } catch {
    return "";
  }
}

/**
 * Merge, de-duplicate and rank. Pure, so the order is testable.
 */
export function rankTargets({ pool, published, keyword, limit = DEFAULT_LIMIT }: RankInput): LinkTarget[] {
  type Scored = { target: LinkTarget; priority: number; relevance: number; origin: number };
  const byUrl = new Map<string, Scored>();

  // Pool rows first: they carry what a person set.
  for (const p of pool) {
    const key = normaliseUrl(p.url);
    if (byUrl.has(key)) continue;
    const fallback = wordsFromPath(p.url);
    const target: LinkTarget = {
      url: p.url,
      title: p.title?.trim() || fallback || p.url,
      keyword: p.keyword?.trim() || fallback,
      anchors: p.anchors?.length ? p.anchors : undefined,
    };
    byUrl.set(key, { target, priority: p.priority, relevance: 0, origin: 2 });
  }

  // Then what we published and what we crawled, in the order given. A URL the
  // pool already has only lends its title or keyword where the pool row had
  // none.
  published.forEach((t, i) => {
    const key = normaliseUrl(t.url);
    const seen = byUrl.get(key);
    if (seen) {
      if (!seen.target.title || seen.target.title === wordsFromPath(seen.target.url) || seen.target.title === seen.target.url) {
        seen.target.title = t.title;
      }
      if (!seen.target.keyword || seen.target.keyword === wordsFromPath(seen.target.url)) {
        seen.target.keyword = t.keyword;
      }
      return;
    }
    // The published list is already ordered with our live articles first;
    // origin preserves that order between equally relevant pages.
    byUrl.set(key, { target: { ...t }, priority: 0, relevance: 0, origin: 1 - i / Math.max(1, published.length) });
  });

  const scored = [...byUrl.values()];
  for (const s of scored) s.relevance = relevance(keyword, s.target);

  scored.sort((a, b) =>
    b.priority - a.priority ||
    b.relevance - a.relevance ||
    b.origin - a.origin,
  );

  return scored.slice(0, limit).map((s) => s.target);
}

/**
 * The pages a draft may link to that were not configured: what we published
 * with a URL we recorded, then what the crawl read. Articles come first: a
 * page we wrote, approved and published is better understood than one we
 * merely read.
 */
export async function fetchPublishedTargets(
  supabase: SupabaseClient,
  workspaceId: string,
  excludeArticleId?: string,
): Promise<LinkTarget[]> {
  let query = supabase
    .from("articles")
    .select("title, keyword, published_url")
    .eq("workspace_id", workspaceId)
    .eq("status", "live")
    .not("published_url", "is", null)
    .order("published_at", { ascending: false, nullsFirst: false });

  if (excludeArticleId) query = query.neq("id", excludeArticleId);

  const { data } = await query;
  const targets: LinkTarget[] = (data ?? [])
    .filter(
      (a): a is { title: string; keyword: string; published_url: string } =>
        Boolean(a.title && a.keyword && a.published_url),
    )
    .map((a) => ({ keyword: a.keyword, title: a.title, url: a.published_url }));

  // Crawled pages that answered, carry a title, and have a term to match on.
  // A page whose keyword had to be guessed from its slug is still a fine link
  // target: the anchor text the writer chooses is matched against title and
  // path as well, and a wrong guess simply scores too low to be picked.
  const { data: crawled } = await supabase
    .from("site_pages")
    .select("url, title, keyword")
    .eq("workspace_id", workspaceId)
    // Articles only. Linking a sentence to /blog or /blog/de sends the reader
    // to an index to search again, which is worse than not linking at all.
    .eq("page_type", "article")
    .gte("status", 200)
    .lt("status", 400)
    .not("title", "is", null)
    .not("keyword", "is", null)
    .order("position", { ascending: true, nullsFirst: false })
    .limit(200);

  const seen = new Set(targets.map((t) => t.url));
  for (const p of crawled ?? []) {
    const url = p.url as string;
    if (seen.has(url)) continue;
    seen.add(url);
    targets.push({ keyword: p.keyword as string, title: p.title as string, url });
  }

  return targets;
}

/** Enabled rows of the configured pool, most important first. */
export async function fetchPoolTargets(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<PoolTarget[]> {
  const { data } = await supabase
    .from("link_targets")
    .select("url, title, keyword, priority, anchors")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .order("priority", { ascending: false })
    .limit(500);

  return (data ?? []).map((r) => ({
    url: r.url as string,
    title: (r.title as string | null) ?? null,
    keyword: (r.keyword as string | null) ?? null,
    priority: (r.priority as number) ?? 0,
    anchors: (r.anchors as string[] | null) ?? [],
  }));
}

/**
 * Every URL on the site we can show exists: the whole configured pool
 * (not the ranked slice the prompt sees), every crawled page, and every
 * published article. This is what the unwrap step and the scorer treat as
 * "known"; a link to a real page ranked 21st in the pool, or to /about (which
 * the pool builder drops as not article-shaped), must not be stripped.
 */
export async function fetchKnownPages(
  supabase: SupabaseClient,
  workspaceId: string,
  excludeArticleId?: string,
): Promise<{ url: string }[]> {
  const [pool, crawled, published] = await Promise.all([
    fetchPoolTargets(supabase, workspaceId),
    supabase.from("site_pages").select("url").eq("workspace_id", workspaceId).limit(5000),
    fetchPublishedTargets(supabase, workspaceId, excludeArticleId),
  ]);
  const seen = new Set<string>();
  const out: { url: string }[] = [];
  for (const row of [...pool, ...((crawled.data ?? []) as { url: string }[]), ...published]) {
    if (!row.url || seen.has(row.url)) continue;
    seen.add(row.url);
    out.push({ url: row.url });
  }
  return out;
}

/**
 * The list the prompt and the resolver both read, for one draft. `limit` is
 * how many the prompt shows; the resolver is handed the same slice so it
 * cannot honour a link to a page the writer was never told about.
 */
export async function getLinkTargetsForPrompt(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { keyword?: string | null; limit?: number; excludeArticleId?: string } = {},
): Promise<LinkTarget[]> {
  const [pool, published] = await Promise.all([
    fetchPoolTargets(supabase, workspaceId),
    fetchPublishedTargets(supabase, workspaceId, opts.excludeArticleId),
  ]);
  return rankTargets({ pool, published, keyword: opts.keyword, limit: opts.limit });
}
