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

import type { SupabaseClient } from "@supabase/supabase-js";
import { tiptapToHtml } from "@/lib/cms/html";
import { decodeEntities } from "@/lib/audit/html-utils";
import { canonicalUrl } from "@/lib/ai/inline-citations";
import { extractLinks, isCitationLink } from "@/lib/seo/links";

export type FirstArticleVerdict = "clean" | "review" | "high_risk";

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
}

export interface FirstArticleFact {
  /** The workspace's first written article, or null when there is none. */
  article: FirstArticleCard | null;
  /** An article is being written right now: not a moment to offer a retry. */
  writing: boolean;
}

/** Written and readable: the same test the pipeline uses before it writes a first draft. */
const WRITTEN = ["review", "approved", "scheduled", "live"];
const VERDICTS = new Set<string>(["clean", "review", "high_risk"]);

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
  opts: { domain: string | null | undefined; scheduledDate: string | null; more: number },
): FirstArticleCard {
  const html = contentHtml(row.content);
  return {
    id: row.id,
    title: row.title ?? "",
    keyword: row.keyword ?? "",
    scheduledDate: opts.scheduledDate,
    outline: articleOutline(html),
    wordCount: row.word_count ?? 0,
    sources: sourcesCited(html, opts.domain),
    verdict: VERDICTS.has(row.fact_check_verdict ?? "") ? (row.fact_check_verdict as FirstArticleVerdict) : null,
    more: Math.max(0, opts.more),
  };
}

/**
 * The workspace's first written article, oldest first: for an account that
 * has not started its trial that is the one setup wrote. Reads through the
 * caller's client, so RLS answers whether they may see it.
 */
export async function loadFirstArticle(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string | null | undefined,
): Promise<FirstArticleFact> {
  const [written, writing] = await Promise.all([
    supabase
      .from("articles")
      .select("id, title, keyword, word_count, fact_check_verdict, content", { count: "exact" })
      .eq("workspace_id", workspaceId)
      .in("status", WRITTEN)
      .not("content", "is", null)
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
  const row = written.data?.[0];
  if (!row) return { article: null, writing: (writing.count ?? 0) > 0 };

  const { data: entry } = await supabase
    .from("calendar_entries")
    .select("scheduled_date")
    .eq("workspace_id", workspaceId)
    .eq("article_id", row.id)
    .order("scheduled_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  return {
    article: toFirstArticleCard(row, {
      domain,
      scheduledDate: (entry?.scheduled_date as string | undefined) ?? null,
      more: (written.count ?? 1) - 1,
    }),
    writing: false,
  };
}
