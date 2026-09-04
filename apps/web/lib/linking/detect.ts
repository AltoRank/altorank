import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchSite } from "@/lib/audit/lenient-fetch";
import {
  articleUrlsFromSitemap,
  looksLikeSitemap,
  sitemapsFromRobots,
} from "@/lib/onboarding/site-discovery";
import { hrefsIn } from "@/lib/seo/links";
import { keywordForPage, locsIn } from "@/lib/seo/site-crawl";

// ---------------------------------------------------------------------------
// Link detection: read the sources, fill the pool
// ---------------------------------------------------------------------------
//
// A source says where to look; a target is a page we may link to. This reads
// every enabled source, collects page URLs, and writes them to `link_targets`
// without touching what a person has already set on a row (priority, anchors,
// enabled). It runs from the "Detect links" button and after each site crawl,
// and it must be safe to run twice: the second run adds nothing and changes
// nothing.
//
// Three kinds of source, three ways of reading:
//
//   sitemap     the site's own list. One level of index nesting, which is all
//               anyone uses. A URL that turns out not to be a sitemap falls
//               back to whatever robots.txt declares on that origin.
//   blog_root   the first page of a blog index, read for its links. Enough for
//               a site with no sitemap; a paginated blog needs a sitemap.
//   manual_url  the URL is the page.
//
// What is stored beside the URL comes from `site_pages` when the crawl has
// been there - title, keyword, the row id - and from the slug otherwise, with
// the same `keywordForPage` the crawl uses so a target inferred two ways does
// not end up with two different keywords.

export type SourceKind = "sitemap" | "blog_root" | "manual_url";

export interface LinkSourceRow {
  id: string;
  workspace_id: string;
  kind: SourceKind;
  url: string;
  enabled: boolean;
  last_detected_at: string | null;
  pages_found: number | null;
  error: string | null;
  created_at: string;
}

export interface DetectedSource {
  id: string;
  kind: SourceKind;
  url: string;
  /** Null when the source could not be read; `error` says why. */
  pagesFound: number | null;
  error: string | null;
}

export interface DetectResult {
  sources: DetectedSource[];
  /** Distinct page URLs across every readable source. */
  found: number;
  /** Of those, how many were already in the pool. */
  alreadyKnown: number;
  /** New rows written this run. */
  added: number;
}

/** A page fetcher, injectable so the parsing can be tested without a network. */
export type Fetcher = (url: string) => Promise<string | null>;

const UA = "AltoRankBot/1.0 (link detection)";
const TIMEOUT_MS = 10_000;
/** Enough for a large blog; past this a sitemap is the whole site, not the writing. */
const MAX_URLS_PER_SOURCE = 2_000;
/** Child sitemaps followed from an index. */
const MAX_CHILD_SITEMAPS = 20;

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetchSite(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.text()).slice(0, 2_000_000);
  } catch {
    return null;
  }
}

// ── Reading one source ─────────────────────────────────────────────────────

export interface SourceRead {
  urls: string[];
  error: string | null;
}

/**
 * The page URLs a sitemap declares, following an index one level down. A
 * sitemap index lists nothing but other sitemaps, so "every loc is XML" is the
 * test for one - the same rule `discoverUrls` applies.
 */
async function readSitemap(url: string, get: Fetcher): Promise<string[] | null> {
  const body = await get(url);
  if (!body || !looksLikeSitemap(body)) return null;

  const locs = locsIn(body);
  const nested = locs.filter((u) => /\.xml(\.gz)?(\?|$)/i.test(u));
  if (nested.length && nested.length === locs.length) {
    const urls = new Set<string>();
    for (const child of nested.slice(0, MAX_CHILD_SITEMAPS)) {
      const childBody = await get(child);
      if (!childBody || !looksLikeSitemap(childBody)) continue;
      for (const u of articleUrlsFromSitemap(childBody, MAX_URLS_PER_SOURCE)) urls.add(u);
      if (urls.size >= MAX_URLS_PER_SOURCE) break;
    }
    return [...urls].slice(0, MAX_URLS_PER_SOURCE);
  }
  return articleUrlsFromSitemap(body, MAX_URLS_PER_SOURCE);
}

/**
 * Same-origin page links from a blog index, resolved against the index URL.
 * Only pages under the index's own path count: a blog's chrome links to
 * pricing and the homepage too, and those are not what a blog root is for.
 */
export function pageLinksFromIndex(html: string, rootUrl: string): string[] {
  let root: URL;
  try {
    root = new URL(rootUrl);
  } catch {
    return [];
  }
  const rootPath = root.pathname.replace(/\/+$/, "");
  const out = new Set<string>();
  for (const href of hrefsIn(html)) {
    let u: URL;
    try {
      u = new URL(href, root);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.host !== root.host) continue;
    u.hash = "";
    u.search = "";
    const path = u.pathname.replace(/\/+$/, "");
    if (path === rootPath) continue;
    if (rootPath && !path.startsWith(`${rootPath}/`)) continue;
    // Pagination and taxonomy pages are indexes too.
    if (/\/(page|tag|tags|category|categories|author|authors)(\/|$)/i.test(path)) continue;
    if (/\.(xml|rss|atom|json|pdf|jpe?g|png|gif|svg|webp)$/i.test(path)) continue;
    out.add(u.toString());
  }
  return [...out];
}

/**
 * Read one source. Never throws: a source that cannot be read reports an
 * error and no URLs, so the others still count.
 */
export async function readSource(
  source: Pick<LinkSourceRow, "kind" | "url">,
  get: Fetcher = fetchText,
): Promise<SourceRead> {
  switch (source.kind) {
    case "manual_url": {
      try {
        const u = new URL(source.url);
        u.hash = "";
        return { urls: [u.toString()], error: null };
      } catch {
        return { urls: [], error: "Not a valid URL." };
      }
    }
    case "blog_root": {
      const html = await get(source.url);
      if (!html) return { urls: [], error: "Could not fetch the blog index." };
      return { urls: pageLinksFromIndex(html, source.url), error: null };
    }
    case "sitemap": {
      const direct = await readSitemap(source.url, get);
      if (direct) return { urls: direct, error: null };

      // Not a sitemap at that address. robots.txt on the same origin may
      // name the real one; try what it declares before giving up.
      let origin = "";
      try {
        origin = new URL(source.url).origin;
      } catch {
        return { urls: [], error: "Not a valid URL." };
      }
      const robots = await get(`${origin}/robots.txt`);
      for (const declared of robots ? sitemapsFromRobots(robots, origin).slice(0, 3) : []) {
        if (declared === source.url) continue;
        const viaRobots = await readSitemap(declared, get);
        if (viaRobots) return { urls: viaRobots, error: null };
      }
      return {
        urls: [],
        error: robots
          ? "Not a sitemap, and robots.txt did not point at one."
          : "Could not fetch the sitemap.",
      };
    }
  }
}

// ── The run ────────────────────────────────────────────────────────────────

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * Onboarding asked for the sitemap and the blog root; they are the first two
 * sources, added once and never re-added. Idempotent: the unique key on
 * (workspace, url) makes a second call a no-op.
 */
export async function ensureDefaultSources(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<void> {
  const { data: ws } = await supabase
    .from("workspaces")
    .select("sitemap_url, blog_root_url")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!ws) return;

  const rows: Array<{ workspace_id: string; kind: SourceKind; url: string }> = [];
  if (ws.sitemap_url) rows.push({ workspace_id: workspaceId, kind: "sitemap", url: ws.sitemap_url as string });
  if (ws.blog_root_url) rows.push({ workspace_id: workspaceId, kind: "blog_root", url: ws.blog_root_url as string });
  if (!rows.length) return;

  await supabase
    .from("link_sources")
    .upsert(rows, { onConflict: "workspace_id,url", ignoreDuplicates: true });
}

/**
 * Read every enabled source and bring `link_targets` up to date.
 *
 * Existing rows keep what a person set on them. What detection may change on
 * a known row is only what it can now say better: a title, keyword or
 * `site_page_id` that was missing and the crawl has since supplied.
 */
export async function detectLinks(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { fetch?: Fetcher } = {},
): Promise<DetectResult> {
  const get = opts.fetch ?? fetchText;

  await ensureDefaultSources(supabase, workspaceId);

  const [{ data: sourceRows, error: sourcesError }, { data: ws }] = await Promise.all([
    supabase
      .from("link_sources")
      .select("id, kind, url, enabled")
      .eq("workspace_id", workspaceId)
      .eq("enabled", true)
      .order("created_at", { ascending: true }),
    supabase.from("workspaces").select("domain").eq("id", workspaceId).maybeSingle(),
  ]);
  if (sourcesError) throw new Error(`link_sources: ${sourcesError.message}`);
  const domain = (ws?.domain as string | undefined) ?? "";

  const sources: DetectedSource[] = [];
  const foundUrls = new Set<string>();
  const now = new Date().toISOString();

  for (const s of (sourceRows ?? []) as Array<Pick<LinkSourceRow, "id" | "kind" | "url">>) {
    const read = await readSource(s, get);
    for (const u of read.urls) foundUrls.add(u);
    const pagesFound = read.error ? null : read.urls.length;
    sources.push({ id: s.id, kind: s.kind, url: s.url, pagesFound, error: read.error });

    // Each source records its own outcome. A failed source keeps its previous
    // count out of the picture: null says "we do not know right now".
    await supabase
      .from("link_sources")
      .update({ last_detected_at: now, pages_found: pagesFound, error: read.error })
      .eq("id", s.id)
      .eq("workspace_id", workspaceId);
  }

  if (foundUrls.size === 0) {
    return { sources, found: 0, alreadyKnown: 0, added: 0 };
  }

  const urls = [...foundUrls];

  // The crawl's knowledge of these pages, when it has any.
  const pages = new Map<string, { id: string; title: string | null; keyword: string | null }>();
  for (let i = 0; i < urls.length; i += 200) {
    const { data } = await supabase
      .from("site_pages")
      .select("id, url, title, keyword")
      .eq("workspace_id", workspaceId)
      .in("url", urls.slice(i, i + 200));
    for (const p of data ?? []) {
      pages.set(p.url as string, {
        id: p.id as string,
        title: (p.title as string | null) ?? null,
        keyword: (p.keyword as string | null) ?? null,
      });
    }
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("link_targets")
    .select("id, url, title, keyword, site_page_id")
    .eq("workspace_id", workspaceId);
  if (existingError) throw new Error(`link_targets: ${existingError.message}`);
  const existing = new Map(
    (existingRows ?? []).map((r) => [
      r.url as string,
      {
        id: r.id as string,
        title: r.title as string | null,
        keyword: r.keyword as string | null,
        site_page_id: r.site_page_id as string | null,
      },
    ]),
  );

  const inserts: Array<Record<string, unknown>> = [];
  let alreadyKnown = 0;

  for (const url of urls) {
    const path = pathOf(url);
    const page = pages.get(url);
    const title = page?.title ?? null;
    const keyword = page?.keyword ?? (path ? keywordForPage(path, null, domain) : null);
    const known = existing.get(url);

    if (!known) {
      inserts.push({
        workspace_id: workspaceId,
        url,
        path,
        title,
        keyword,
        source: "detected",
        site_page_id: page?.id ?? null,
      });
      continue;
    }

    alreadyKnown++;
    // Fill blanks only. A title or keyword already on the row may have been
    // typed by a person; a crawl result does not override that.
    const patch: Record<string, unknown> = {};
    if (!known.title && title) patch.title = title;
    if (!known.keyword && keyword) patch.keyword = keyword;
    if (!known.site_page_id && page?.id) patch.site_page_id = page.id;
    if (Object.keys(patch).length) {
      await supabase
        .from("link_targets")
        .update(patch)
        .eq("id", known.id)
        .eq("workspace_id", workspaceId);
    }
  }

  for (let i = 0; i < inserts.length; i += 100) {
    const { error } = await supabase
      .from("link_targets")
      .upsert(inserts.slice(i, i + 100), { onConflict: "workspace_id,url", ignoreDuplicates: true });
    if (error) throw new Error(`link_targets insert: ${error.message}`);
  }

  return { sources, found: urls.length, alreadyKnown, added: inserts.length };
}
