import type { SupabaseClient } from "@supabase/supabase-js";
import { stripDeadLinks } from "@/lib/ai/utils";

// ---------------------------------------------------------------------------
// Internal links: one library, offered to the writer and resolved afterwards
// ---------------------------------------------------------------------------
//
// The model writes `<a href="{{internal-link:KEYWORD}}">anchor</a>` for the
// pages it was told exist, and this module turns each placeholder into the
// page's real URL. Two rules, both learned the hard way (2026-09-03):
//
//   1. The prompt and the resolver read the SAME list. The prompt used to
//      offer every sibling with content, in any status, while the resolver
//      only matched `live` rows. The model dutifully linked to drafts, the
//      resolver found nothing, and every generated article shipped with its
//      internal links pointing at `#` or at a guessed path.
//
//   2. A target is a page with a URL we have observed, which means a live
//      article with `published_url`. There is no workspace-wide blog base URL
//      to build one from (the derivation in lib/cms/blog-url.ts is per git
//      integration), so `domain/slug` was a guess and usually a 404.
//
// A placeholder that cannot be resolved is unwrapped to its text. A link that
// goes nowhere is worse than no link: it looks clickable, wastes a reader, and
// publishes as an internal 404 for a crawler.

export interface LinkTarget {
  keyword: string;
  title: string;
  url: string;
}

/**
 * Pages of this site a draft may link to. Used by the prompt (so the writer
 * knows what exists) and by the resolver (so what it wrote can be honoured),
 * so the two cannot disagree.
 *
 * Two sources, and the second is the one that matters on a real site:
 *
 *   articles    what AltoRank wrote and published, with a URL we recorded.
 *   site_pages  what the customer had already published before they arrived,
 *               discovered from their own sitemap by lib/seo/site-crawl.ts.
 *
 * Until the crawl existed this was articles alone, so a customer with 204
 * published posts had zero link targets and every generated draft linked to
 * nothing. Articles come first: a page we wrote, approved and published is
 * better understood than one we merely read.
 */
export async function fetchLinkTargets(
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
  // A page whose keyword had to be guessed from its H1 is still a fine link
  // target: the anchor text the writer chooses is matched against title and
  // path as well, and a wrong guess simply scores too low to be picked.
  const { data: crawled } = await supabase
    .from("site_pages")
    .select("url, title, keyword")
    .eq("workspace_id", workspaceId)
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

/**
 * Resolve every `{{internal-link:topic}}` placeholder in `html` against
 * `targets`, and unwrap the ones that match nothing.
 *
 * Pure: the caller fetches the targets once and hands the same list to the
 * prompt. Each target is used at most once, so two placeholders for related
 * topics do not both land on the same page.
 */
export function resolveInternalLinks(html: string, targets: LinkTarget[]): string {
  const placeholderRegex = /\{\{internal-link:([^}]+)\}\}/g;
  const topics = new Set<string>();
  for (const m of html.matchAll(placeholderRegex)) topics.add(m[1].trim().toLowerCase());
  if (topics.size === 0) return html;

  const resolved = new Map<string, string>();
  const used = new Set<string>();
  for (const topic of topics) {
    const best = findBestMatch(topic, targets, used);
    if (best) {
      resolved.set(topic, best.url);
      used.add(best.url);
    }
  }

  const linked = html.replace(
    /href=(["'])\{\{internal-link:([^}]+)\}\}\1/g,
    (full, quote: string, rawTopic: string) => {
      const url = resolved.get(rawTopic.trim().toLowerCase());
      return url ? `href=${quote}${escapeAttr(url)}${quote}` : full;
    },
  );

  // Whatever is still a placeholder matched nothing. Keep the words, drop
  // the link: this is the same rule extractArticleMeta applies to `#`, run
  // here because the placeholders had to survive that pass to reach us.
  return stripDeadLinks(linked, { placeholders: true });
}

function escapeAttr(url: string): string {
  return url.replace(/"/g, "%22").replace(/'/g, "%27");
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Below this the overlap is a shared stopword or two, not a shared subject. */
const MIN_SCORE = 0.15;

function findBestMatch(
  topic: string,
  targets: LinkTarget[],
  used: Set<string>,
): LinkTarget | null {
  let bestScore = 0;
  let best: LinkTarget | null = null;

  for (const target of targets) {
    if (used.has(target.url)) continue;
    const score = scoreSimilarity(topic, target);
    if (score > bestScore) {
      bestScore = score;
      best = target;
    }
  }

  return best && bestScore >= MIN_SCORE ? best : null;
}

function scoreSimilarity(topic: string, target: LinkTarget): number {
  if (target.keyword.trim().toLowerCase() === topic) return 1;

  const topicWords = tokenize(topic);
  const keywordOverlap = wordOverlap(topicWords, tokenize(target.keyword));
  const titleOverlap = wordOverlap(topicWords, tokenize(target.title));
  const slugOverlap = wordOverlap(topicWords, tokenize(pathWords(target.url)));

  return keywordOverlap * 0.5 + titleOverlap * 0.35 + slugOverlap * 0.15;
}

function pathWords(url: string): string {
  try {
    return new URL(url).pathname.replace(/[-_/]+/g, " ");
  } catch {
    return url.replace(/[-_/]+/g, " ");
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function wordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const matches = a.filter((w) => setB.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return matches / union;
}
