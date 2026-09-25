// ---------------------------------------------------------------------------
// What already owns a search: the topics a new one is compared against
// ---------------------------------------------------------------------------
//
// The duplicate checks used to compare candidates with each other and nothing
// else, so a keyword already drafted could be planned again under a synonym
// the next day (a real signup, 2026-09-22). A search is owned by anything
// already live, drafted or scheduled, and these are read from three places:
//
//   keywords     rows in flight: planned (scheduled), drafting or scheduled
//                (drafted), shipped (live), with the results page bought
//                when they were qualified
//   articles     every article that is not an error or archived, live when
//                published; its keyword row's results page when it has one
//   site_pages   the site's own pages and the query each one targets (filled
//                from its heading or from a Search Console ranking), live
//
// A site page carries no results page of its own, so it is compared by words.
// Qualification separately refuses any query the site's own URL already ranks
// for in the top ten (cause "existing_page"), which is the results-page half
// of the same question.

import type { SupabaseClient } from "@supabase/supabase-js";
import { storedSerp, type IntentStage, type StagedTopic } from "./intent";

export interface IntentLeader extends StagedTopic {
  kind: "keyword" | "article" | "page";
  /** The keyword row, when there is one. */
  keywordId: string | null;
  articleId?: string;
  url?: string;
}

/** A keyword row's stage from its status; null for a row not in flight. */
export function keywordStage(status: string | null | undefined): IntentStage | null {
  switch (status) {
    case "shipped": return "live";
    case "drafting":
    case "scheduled": return "drafted";
    case "planned": return "scheduled";
    default: return null;
  }
}

/** An article's stage from its status; null for one that holds no search (failed, archived). */
export function articleStage(status: string | null | undefined): IntentStage | null {
  if (status === "live") return "live";
  if (status === "error" || status === "archived") return null;
  return "drafted";
}

const RANK: Record<IntentStage, number> = { live: 3, drafted: 2, scheduled: 1, candidate: 0 };
const further = (a: IntentStage, b: IntentStage): IntentStage => (RANK[a] >= RANK[b] ? a : b);

type KeywordRow = { id: string; term: string; status: string | null; opportunity?: unknown };
type ArticleRow = { id: string; keyword: string | null; keyword_id?: string | null; status?: string | null };
type PageRow = { url: string; keyword: string | null };

/**
 * Pure: the leaders, from rows already read. An article on an in-flight
 * keyword row raises that row's stage rather than adding a second leader; an
 * article with no row is a leader of its own, compared by words.
 */
export function leadersFrom(keywords: readonly KeywordRow[], articles: readonly ArticleRow[], pages: readonly PageRow[]): IntentLeader[] {
  const byKeyword = new Map<string, IntentLeader>();
  for (const k of keywords) {
    const stage = keywordStage(k.status);
    if (!stage || !k.term) continue;
    byKeyword.set(k.id, { kind: "keyword", keywordId: k.id, term: k.term, organicUrls: storedSerp(k.opportunity), stage });
  }
  const out: IntentLeader[] = [];
  for (const a of articles) {
    const stage = articleStage(a.status);
    if (!stage || !a.keyword?.trim()) continue;
    const row = a.keyword_id ? byKeyword.get(a.keyword_id) : undefined;
    if (row) {
      row.stage = further(row.stage, stage);
      row.articleId ??= a.id;
      continue;
    }
    out.push({ kind: "article", keywordId: a.keyword_id ?? null, articleId: a.id, term: a.keyword, organicUrls: null, stage });
  }
  for (const p of pages) {
    if (!p.keyword?.trim()) continue;
    out.push({ kind: "page", keywordId: null, url: p.url, term: p.keyword, organicUrls: null, stage: "live" });
  }
  return [...byKeyword.values(), ...out];
}

/**
 * Everything live, drafted or scheduled in a workspace. Throws when a read
 * fails: comparing against half the leaders is how a duplicate gets through
 * with nothing in the log.
 */
export async function readIntentLeaders(supabase: SupabaseClient, workspaceId: string): Promise<IntentLeader[]> {
  const [keywords, articles, pages] = await Promise.all([
    supabase
      .from("keywords")
      .select("id, term, status, opportunity")
      .eq("workspace_id", workspaceId)
      .in("status", ["planned", "drafting", "scheduled", "shipped"]),
    supabase
      .from("articles")
      .select("id, keyword, keyword_id, status")
      .eq("workspace_id", workspaceId)
      .not("keyword", "is", null),
    supabase
      .from("site_pages")
      .select("url, keyword")
      .eq("workspace_id", workspaceId)
      .not("keyword", "is", null),
  ]);
  for (const [what, res] of [["keywords", keywords], ["articles", articles], ["site pages", pages]] as const) {
    if (res.error) throw new Error(`Could not read ${what} to check for duplicate topics: ${res.error.message}`);
  }
  return leadersFrom(
    (keywords.data ?? []) as KeywordRow[],
    (articles.data ?? []) as ArticleRow[],
    (pages.data ?? []) as PageRow[],
  );
}

/** "drafted", "live", "on the calendar": how far the leader got, for a reason line. */
export function stageWords(stage: IntentStage): string {
  return stage === "live" ? "live" : stage === "drafted" ? "already drafted" : stage === "scheduled" ? "on the calendar" : "planned";
}
