// ---------------------------------------------------------------------------
// The first article, as the trial gate shows it: its shape, never its text
// ---------------------------------------------------------------------------
//
// Setup writes one article before the card is asked for. The gate screen shows
// that article so the person can see what the trial opens - and only its
// shape: title, target keyword, the day it is scheduled for, the H2 outline,
// the length and how many sources it cites. No body, no intro paragraph, no
// meta description, nothing worth copying. A real signup (2026-09-22) copied
// the whole text off the preview the gate used to link to and published it on
// their own site within the hour.
//
// Everything here is derived on the server. The text is read to count and to
// pull the headings out, and it never reaches the props of the component that
// renders the card.
//
// "Has a first article" is a fact about the WORKSPACE - an article row exists
// - and not about whichever onboarding run happens to be the latest. Reading
// it off the run is what made the gate say "draft not ready" beside an email
// that said it was, and offer a retry that re-ran the whole setup (about
// $0.22 of provider calls) for an article that already existed.

import { topicLabels, type TopicLabel } from "@/lib/keyword-research/topic-labels";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tiptapToHtml } from "@/lib/cms/html";
import { decodeEntities } from "@/lib/audit/html-utils";
import { canonicalUrl } from "@/lib/ai/inline-citations";
import { extractLinks, isCitationLink } from "@/lib/seo/links";
import { readArticlesWhole } from "@/lib/articles/body-read";
import type { FactCheckReport } from "@/lib/ai/fact-check";
import { outlineHeadings, outlineOf, type ArticleOutline } from "@/lib/content/outline";
import { supportedLocales } from "@/lib/i18n/locale";

// The fact check's own verdicts, so a verdict it adds reaches the card: a
// draft in a language the checker does not read is `unchecked` (migration
// 098), and the card says so rather than showing nothing.
export type FirstArticleVerdict = FactCheckReport["verdict"];

export interface FirstArticleCard {
  id: string;
  title: string;
  keyword: string;
  /** YYYY-MM-DD of its calendar day, or null when it is not on the calendar. */
  scheduledDate: string | null;
  /** The H2 headings, in order, as text. */
  outline: string[];
  wordCount: number;
  /** Distinct outside pages the article links to as sources. */
  sources: number;
  verdict: FirstArticleVerdict | null;
  /** Further written drafts the workspace holds beyond this one. */
  more: number;
  /** What the topic's verdict says about itself: lower confidence, unmeasured (lib/keyword-research/topic-labels.ts). */
  labels: TopicLabel[];
  /**
   * `outlined`: the outline exists and the body is being written behind it
   * (lib/content/outline.ts). The headings are the outline's, the length is
   * its target and the sources the ones it plans to cite; there is no fact
   * check yet. `written`: read off the finished body.
   */
  state: "outlined" | "written";
  /**
   * The last heading when it is the site's own closing - "Learn more about
   * <the business>", added by enrichment (lib/content/enrich/cta.ts) - and
   * not a section of the article. The gate leaves it out of the outline it
   * shows: listed there it read as a section of brand plug (UX audit
   * 2026-10-12). Absent when the article has none.
   */
  closing?: string;
}

export interface FirstArticleFact {
  /** The workspace's first written article, or null when there is none. */
  article: FirstArticleCard | null;
  /** An article is being written right now: not a moment to offer a retry. */
  writing: boolean;
}

/** Written and readable: the same test the pipeline uses before it writes a first draft. */
const WRITTEN = ["review", "approved", "scheduled", "live"];
const VERDICTS = new Set<string>(["clean", "review", "high_risk", "unchecked"] satisfies FirstArticleVerdict[]);

function text(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** The article's HTML from what `articles.content` holds: Tiptap JSON, or HTML on old rows. */
export function contentHtml(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") return tiptapToHtml(content as Record<string, unknown>);
  return "";
}

/** The H2 headings, in order. Empty headings are dropped rather than shown as blanks. */
export function articleOutline(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)) {
    const heading = text(m[1]);
    if (heading) out.push(heading);
  }
  return out;
}

/**
 * Whether a heading is the closing call to action enrichment adds, in any
 * language the contract describes: "Learn more about X", "Scopri di più su X"
 * and the rest, whatever X is.
 */
export function isClosingHeading(heading: string): boolean {
  const h = heading.trim();
  return supportedLocales().some((locale) => {
    const [before, after] = locale.labels.learnMore("\u0000").split("\u0000");
    return h.length > before.length + after.length && h.startsWith(before) && h.endsWith(after);
  });
}

/**
 * How many different outside pages the article cites. Two spellings of one
 * page (a tracking parameter, a trailing slash) are one source, the same rule
 * the citation check uses.
 */
export function sourcesCited(html: string, siteDomain: string | null | undefined): number {
  const seen = new Set<string>();
  for (const link of extractLinks(html, siteDomain)) {
    if (isCitationLink(link.href, siteDomain)) seen.add(canonicalUrl(link.href));
  }
  return seen.size;
}

/**
 * The first article's card, derived from the row.
 *
 * Pure, so the rule "the card carries no text" is a test and not a promise:
 * the returned object has no field a body could travel in.
 */
export function toFirstArticleCard(
  row: {
    id: string;
    title: string | null;
    keyword: string | null;
    word_count: number | null;
    fact_check_verdict: string | null;
    content: unknown;
  },
  opts: { domain: string | null | undefined; scheduledDate: string | null; more: number; verdict?: unknown; volume?: number | null },
): FirstArticleCard {
  const html = contentHtml(row.content);
  const outline = articleOutline(html);
  const last = outline[outline.length - 1];
  return {
    id: row.id,
    title: row.title ?? "",
    keyword: row.keyword ?? "",
    scheduledDate: opts.scheduledDate,
    outline,
    ...(last && isClosingHeading(last) ? { closing: last } : {}),
    wordCount: row.word_count ?? 0,
    sources: sourcesCited(html, opts.domain),
    verdict: VERDICTS.has(row.fact_check_verdict ?? "") ? (row.fact_check_verdict as FirstArticleVerdict) : null,
    more: Math.max(0, opts.more),
    labels: topicLabels(opts.verdict ?? null, { volume: opts.volume ?? null }),
    state: "written",
  };
}

/**
 * The card for a first article that is outlined and still being written:
 * the outline is the shape, since the owner is shown it before the body and
 * the body is held to it. Pure, and like the written card it has no field a
 * body could travel in.
 */
export function toOutlinedCard(
  row: { id: string; keyword: string | null },
  outline: ArticleOutline,
  opts: { scheduledDate: string | null; verdict?: unknown; volume?: number | null },
): FirstArticleCard {
  return {
    id: row.id,
    title: outline.title,
    keyword: row.keyword ?? "",
    scheduledDate: opts.scheduledDate,
    outline: outlineHeadings(outline),
    ...(outline.closing ? { closing: outline.closing } : {}),
    wordCount: outline.targetWordCount,
    sources: outline.sources.length,
    verdict: null,
    more: 0,
    labels: topicLabels(opts.verdict ?? null, { volume: opts.volume ?? null }),
    state: "outlined",
  };
}

/**
 * The workspace's first written article, oldest first: for an account that
 * has not started its trial that is the one setup wrote.
 *
 * Which row is asked through the caller's client, so RLS answers whether
 * they may see it. The text the outline is pulled from is read on the server
 * (lib/articles/body-read.ts): no client token can select it since migration
 * 097, and it goes no further than this function - the card it returns has
 * no field a body could travel in.
 */
export async function loadFirstArticle(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string | null | undefined,
): Promise<FirstArticleFact> {
  const [written, writing] = await Promise.all([
    supabase
      .from("articles")
      .select("id, title, keyword, keyword_id, word_count, fact_check_verdict", { count: "exact" })
      .eq("workspace_id", workspaceId)
      .in("status", WRITTEN)
      // A written article has words; the text itself is not a column this
      // client may filter on.
      .gt("word_count", 0)
      .order("created_at", { ascending: true })
      .limit(1),
    supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "drafting"),
  ]);
  // A failed read is not "no article": saying none would offer the retry
  // that re-runs setup for an article that exists.
  if (written.error) throw new Error(`first article: could not read this site's articles (${written.error.message})`);
  // Nor is a failed read "nothing being written": saying so would offer the
  // same retry while the article is being written.
  if (writing.error) throw new Error(`first article: could not tell whether an article is being written (${writing.error.message})`);
  const found = written.data?.[0];
  if (!found) {
    // Nothing written yet: an outlined first article, when there is one, is
    // the card - its body is being written to the outline it shows.
    const outlined = (writing.count ?? 0) > 0 ? await loadOutlinedCard(supabase, workspaceId) : null;
    return { article: outlined, writing: (writing.count ?? 0) > 0 };
  }
  const [body] = await readArticlesWhole<{ content: unknown }>([found.id as string], "content");
  const row = { ...found, content: body?.content ?? null };

  const keywordId = (found as { keyword_id?: string | null }).keyword_id ?? null;
  const [{ data: entry }, { data: topic }] = await Promise.all([
    supabase
      .from("calendar_entries")
      .select("scheduled_date")
      .eq("workspace_id", workspaceId)
      .eq("article_id", row.id)
      .order("scheduled_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
    // The verdict the topic was planned on, for its labels. A failed read is
    // a card without labels, not a failed card.
    keywordId
      ? supabase.from("keywords").select("opportunity, volume").eq("workspace_id", workspaceId).eq("id", keywordId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return {
    article: toFirstArticleCard(row, {
      domain,
      scheduledDate: (entry?.scheduled_date as string | undefined) ?? null,
      more: (written.count ?? 1) - 1,
      verdict: (topic as { opportunity?: unknown } | null)?.opportunity ?? null,
      volume: (topic as { volume?: number | null } | null)?.volume ?? null,
    }),
    writing: false,
  };
}

/**
 * The title of the article the gate shows (`loadFirstArticle`): the site's
 * oldest written article, or null when it has none. Only the title, through
 * the caller's client, so no body column is read. Never throws: a page that
 * only names the article does without the name.
 */
export async function firstArticleTitle(supabase: SupabaseClient, workspaceId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("title")
      .eq("workspace_id", workspaceId)
      .in("status", WRITTEN)
      .gt("word_count", 0)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const title = error ? null : (data as { title?: unknown } | null)?.title;
    return typeof title === "string" && title.trim() ? title.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The oldest article being written that carries an outline, as its card, or
 * null. Through the caller's client: the outline and the title are not body
 * columns (migration 097 withholds only the text and what quotes it).
 */
async function loadOutlinedCard(supabase: SupabaseClient, workspaceId: string): Promise<FirstArticleCard | null> {
  const { data, error } = await supabase
    .from("articles")
    .select("id, keyword, keyword_id, instructions_snapshot")
    .eq("workspace_id", workspaceId)
    .eq("status", "drafting")
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(`first article: could not read the article being written (${error.message})`);
  const row = (data?.[0] as { id: string; keyword: string | null; keyword_id: string | null; instructions_snapshot: unknown } | undefined) ?? null;
  const outline = row ? outlineOf(row.instructions_snapshot) : null;
  if (!row || !outline) return null;
  const [{ data: entry }, { data: topic }] = await Promise.all([
    supabase
      .from("calendar_entries")
      .select("scheduled_date")
      .eq("workspace_id", workspaceId)
      .eq("article_id", row.id)
      .order("scheduled_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
    row.keyword_id
      ? supabase.from("keywords").select("opportunity, volume").eq("workspace_id", workspaceId).eq("id", row.keyword_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return toOutlinedCard(row, outline, {
    scheduledDate: (entry?.scheduled_date as string | undefined) ?? null,
    verdict: (topic as { opportunity?: unknown } | null)?.opportunity ?? null,
    volume: (topic as { volume?: number | null } | null)?.volume ?? null,
  });
}
