import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Internal link resolver — replaces {{internal-link:topic}} placeholders
// with real article URLs from the workspace's published content.
// ---------------------------------------------------------------------------

type LinkCandidate = {
  slug: string;
  title: string;
  keyword: string;
  published_url: string | null;
  domain: string;
};

/**
 * Resolve all `{{internal-link:topic}}` placeholders in article HTML.
 *
 * Strategy:
 * 1. Find all placeholders in the HTML
 * 2. Fetch published articles + workspace domain for this workspace
 * 3. For each placeholder topic, score candidates by keyword/title overlap
 * 4. Replace with real URL (domain + slug) or fallback to /slug
 */
export async function resolveInternalLinks(
  supabase: SupabaseClient,
  html: string,
  workspaceId: string,
  excludeArticleId?: string,
): Promise<string> {
  const placeholderRegex = /\{\{internal-link:([^}]+)\}\}/g;
  const topics = new Set<string>();
  let match = placeholderRegex.exec(html);
  while (match) {
    topics.add(match[1].trim().toLowerCase());
    match = placeholderRegex.exec(html);
  }

  if (topics.size === 0) return html;

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("domain")
    .eq("id", workspaceId)
    .single();

  const domain = workspace?.domain ?? "";

  let query = supabase
    .from("articles")
    .select("slug, title, keyword, published_url")
    .eq("workspace_id", workspaceId)
    .eq("status", "live");

  if (excludeArticleId) {
    query = query.neq("id", excludeArticleId);
  }

  const { data: articles } = await query;

  if (!articles || articles.length === 0) {
    return stripPlaceholders(html);
  }

  const candidates: LinkCandidate[] = articles.map((a) => ({
    slug: a.slug,
    title: a.title ?? "",
    keyword: a.keyword ?? "",
    published_url: a.published_url,
    domain,
  }));

  const resolved = new Map<string, string>();
  const usedSlugs = new Set<string>();

  for (const topic of topics) {
    const best = findBestMatch(topic, candidates, usedSlugs);
    if (best) {
      resolved.set(topic, best.url);
      usedSlugs.add(best.slug);
    }
  }

  return html.replace(
    /href="(\{\{internal-link:([^}]+)\}\})"/g,
    (_full, _placeholder, rawTopic: string) => {
      const topic = rawTopic.trim().toLowerCase();
      const url = resolved.get(topic);
      if (url) {
        return `href="${url}"`;
      }
      const slug = topic.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      return `href="/${slug}"`;
    },
  );
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function findBestMatch(
  topic: string,
  candidates: LinkCandidate[],
  usedSlugs: Set<string>,
): { url: string; slug: string } | null {
  let bestScore = 0;
  let bestCandidate: LinkCandidate | null = null;

  for (const candidate of candidates) {
    if (usedSlugs.has(candidate.slug)) continue;

    const score = scoreSimilarity(topic, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate || bestScore < 0.15) return null;

  const url =
    bestCandidate.published_url ||
    buildUrl(bestCandidate.domain, bestCandidate.slug);

  return { url, slug: bestCandidate.slug };
}

function scoreSimilarity(topic: string, candidate: LinkCandidate): number {
  const topicWords = tokenize(topic);
  const titleWords = tokenize(candidate.title);
  const keywordWords = tokenize(candidate.keyword);
  const slugWords = tokenize(candidate.slug.replace(/-/g, " "));

  if (candidate.keyword.toLowerCase() === topic) return 1.0;

  const titleOverlap = wordOverlap(topicWords, titleWords);
  const keywordOverlap = wordOverlap(topicWords, keywordWords);
  const slugOverlap = wordOverlap(topicWords, slugWords);

  return keywordOverlap * 0.5 + titleOverlap * 0.35 + slugOverlap * 0.15;
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

function buildUrl(domain: string, slug: string): string {
  if (!domain) return `/${slug}`;
  const base = domain.startsWith("http") ? domain : `https://${domain}`;
  return `${base.replace(/\/$/, "")}/${slug}`;
}

// ---------------------------------------------------------------------------
// Fallback: strip placeholders but keep anchor text
// ---------------------------------------------------------------------------

function stripPlaceholders(html: string): string {
  return html.replace(
    /href="\{\{internal-link:[^}]+\}\}"/g,
    'href="#"',
  );
}
