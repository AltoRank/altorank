import type { SupabaseClient } from "@supabase/supabase-js";
import { stripDeadLinks } from "@/lib/ai/utils";
import { getLinkTargetsForPrompt } from "@/lib/linking/targets";

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
//      article with `published_url`, a page the crawl read, or a row of the
//      configured link pool. There is no workspace-wide blog base URL to
//      build one from (the derivation in lib/cms/blog-url.ts is per git
//      integration), so `domain/slug` was a guess and usually a 404.
//
// A placeholder that cannot be resolved is unwrapped to its text. A link that
// goes nowhere is worse than no link: it looks clickable, wastes a reader, and
// publishes as an internal 404 for a crawler.

export interface LinkTarget {
  keyword: string;
  title: string;
  url: string;
  /**
   * Anchor texts the site owner prefers for this page, from the link pool.
   * When set, the resolver uses one of them as the link's text.
   */
  anchors?: string[];
}

/**
 * Pages of this site a draft may link to. Used by the prompt (so the writer
 * knows what exists) and by the resolver (so what it wrote can be honoured),
 * so the two cannot disagree.
 *
 * The list is the configured pool on /linking merged with our own live
 * articles and the crawl's pages, ranked for the article being written; see
 * lib/linking/targets.ts. Pass `keyword` so the ranking can prefer pages on
 * the draft's subject.
 */
export async function fetchLinkTargets(
  supabase: SupabaseClient,
  workspaceId: string,
  excludeArticleId?: string,
  opts: { keyword?: string | null; limit?: number } = {},
): Promise<LinkTarget[]> {
  return getLinkTargetsForPrompt(supabase, workspaceId, { ...opts, excludeArticleId });
}

/**
 * Resolve every `{{internal-link:topic}}` placeholder in `html` against
 * `targets`, and unwrap the ones that match nothing.
 *
 * Pure: the caller fetches the targets once and hands the same list to the
 * prompt. Each target is used at most once, so two placeholders for related
 * topics do not both land on the same page.
 *
 * A target with preferred anchors gets one of them as the link text: the one
 * the writer already used if it is on the list, the first otherwise. A target
 * without anchors keeps whatever the writer wrote.
 */
export function resolveInternalLinks(html: string, targets: LinkTarget[]): string {
  const placeholderRegex = /\{\{internal-link:([^}]+)\}\}/g;
  const topics = new Set<string>();
  for (const m of html.matchAll(placeholderRegex)) topics.add(m[1].trim().toLowerCase());
  if (topics.size === 0) return html;

  const resolved = new Map<string, LinkTarget>();
  const used = new Set<string>();
  for (const topic of topics) {
    const best = findBestMatch(topic, targets, used);
    if (best) {
      resolved.set(topic, best);
      used.add(best.url);
    }
  }

  const linked = html.replace(
    /<a\b([^>]*?)href=(["'])\{\{internal-link:([^}]+)\}\}\2([^>]*)>([\s\S]*?)<\/a>/gi,
    (full, before: string, quote: string, rawTopic: string, after: string, text: string) => {
      const target = resolved.get(rawTopic.trim().toLowerCase());
      if (!target) return full;
      const href = `href=${quote}${escapeAttr(target.url)}${quote}`;
      return `<a${before}${href}${after}>${preferredAnchor(text, target)}</a>`;
    },
  );

  // Whatever is still a placeholder matched nothing. Keep the words, drop
  // the link: this is the same rule extractArticleMeta applies to `#`, run
  // here because the placeholders had to survive that pass to reach us.
  return stripDeadLinks(linked, { placeholders: true });
}

/** The link text to publish: the writer's, unless the pool prefers otherwise. */
export function preferredAnchor(written: string, target: LinkTarget): string {
  const anchors = (target.anchors ?? []).map((a) => a.trim()).filter(Boolean);
  if (anchors.length === 0) return written;
  const plain = written.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const kept = anchors.find((a) => a.toLowerCase() === plain);
  return escapeText(kept ?? anchors[0]);
}

function escapeAttr(url: string): string {
  return url.replace(/"/g, "%22").replace(/'/g, "%27");
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  // A preferred anchor names the page as its owner would; matching one is as
  // good as matching the keyword.
  if ((target.anchors ?? []).some((a) => a.trim().toLowerCase() === topic)) return 1;

  const topicWords = tokenize(topic);
  const keywordOverlap = wordOverlap(topicWords, tokenize(target.keyword));
  const titleOverlap = wordOverlap(topicWords, tokenize(target.title));
  const slugOverlap = wordOverlap(topicWords, tokenize(pathWords(target.url)));
  const anchorOverlap = Math.max(
    0,
    ...(target.anchors ?? []).map((a) => wordOverlap(topicWords, tokenize(a))),
  );

  return Math.max(
    keywordOverlap * 0.5 + titleOverlap * 0.35 + slugOverlap * 0.15,
    anchorOverlap * 0.6,
  );
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
