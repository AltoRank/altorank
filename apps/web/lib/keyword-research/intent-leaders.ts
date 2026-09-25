// ---------------------------------------------------------------------------
// What already owns a search: the topics a new one is compared against
// ---------------------------------------------------------------------------
//
// The duplicate checks used to compare candidates with each other and nothing
// else, so a keyword already drafted could be planned again under a synonym
// the next day (a real signup, 2026-09-22). A search is owned by anything
// already live, drafted or scheduled, and these are read from four places:
//
//   keywords     rows in flight: drafting or scheduled (drafted), shipped
//                (live), and planned (scheduled) - a planned row only while
//                it will still be written - with the results page bought
//                when they were qualified
//   articles     every article that is not an error or archived, live when
//                published; its keyword row's results page when it has one,
//                whatever that row's status is now
//   site_pages   the site's own pages and the query each one targets (filled
//                from its heading or from a Search Console ranking), live
//   calendar     the date each planned row is due, so of two planned rows of
//                one search the one due first leads
//
// A planned row is a promise, not a fact. One the recommender has refused,
// or that no longer has a current approval, cannot own a search: it would
// park the phrasing that can be written and then not be written itself, and
// the search is lost until a person notices. So the caller says which planned
// rows will still be written (`OnCalendar`); drafted and live ones own theirs
// whatever it says.
//
// A site page carries no results page of its own, so it is compared by words.
// Qualification separately refuses any query the site's own URL already ranks
// for in the top ten (cause "existing_page"), which is the results-page half
// of the same question. Search Console's page-per-query rows are not read as
// owners: they say where Google landed an impression, which for a term at
// position 30 is usually the homepage, a page that targets nothing
// (lib/seo/recommendations.ts reads them the same way).

import { readAll } from "@/lib/supabase/read-all";
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

export type KeywordRow = { id: string; term: string; status: string | null; opportunity?: unknown };
type ArticleRow = { id: string; keyword: string | null; keyword_id?: string | null; status?: string | null };
type PageRow = { url: string; keyword: string | null };
type EntryRow = { keyword_id: string | null; scheduled_date: string | null };

/**
 * Whether a planned row will still be written, as the caller can tell. The
 * recommender knows it exactly (writable, and a current approval); anything
 * else reads the approval (`approvedUnder` in ./opportunity.ts).
 */
export type OnCalendar = (row: KeywordRow) => boolean;

/**
 * The approval as stored, whatever its age or profile: for a screen that
 * counts topics against verdicts read the same way (the trial screen's held
 * topics), never for a decision to write or park.
 */
export const approvedWhenJudged: OnCalendar = (row) =>
  Boolean(row.opportunity && typeof row.opportunity === "object" && (row.opportunity as { status?: unknown }).status === "qualified");

export interface LeaderSources {
  /**
   * Keyword rows: the ones in flight, and the rows articles point at (any
   * status), so an article compares by its results page, not only its words.
   */
  keywords: readonly KeywordRow[];
  articles: readonly ArticleRow[];
  pages: readonly PageRow[];
  /** Calendar entries still to come; the earliest date per row is its date. */
  entries?: readonly EntryRow[];
}

/**
 * Pure: the leaders, from rows already read. An article on an in-flight
 * keyword row raises that row's stage rather than adding a second leader; an
 * article with no row in flight is a leader of its own, compared by its row's
 * results page when the row has one and by words otherwise.
 */
export function leadersFrom(sources: LeaderSources, onCalendar: OnCalendar): IntentLeader[] {
  const dateOf = new Map<string, string>();
  for (const e of sources.entries ?? []) {
    if (!e.keyword_id || !e.scheduled_date) continue;
    const prev = dateOf.get(e.keyword_id);
    if (!prev || e.scheduled_date < prev) dateOf.set(e.keyword_id, e.scheduled_date);
  }
  const rowById = new Map(sources.keywords.map((k) => [k.id, k]));
  const byKeyword = new Map<string, IntentLeader>();
  for (const k of sources.keywords) {
    const stage = keywordStage(k.status);
    if (!stage || !k.term) continue;
    if (stage === "scheduled" && !onCalendar(k)) continue;
    byKeyword.set(k.id, { kind: "keyword", keywordId: k.id, term: k.term, organicUrls: storedSerp(k.opportunity), stage, date: dateOf.get(k.id) ?? null });
  }
  const out: IntentLeader[] = [];
  for (const a of sources.articles) {
    const stage = articleStage(a.status);
    if (!stage || !a.keyword?.trim()) continue;
    const leader = a.keyword_id ? byKeyword.get(a.keyword_id) : undefined;
    if (leader) {
      leader.stage = further(leader.stage, stage);
      leader.articleId ??= a.id;
      continue;
    }
    const row = a.keyword_id ? rowById.get(a.keyword_id) : undefined;
    out.push({ kind: "article", keywordId: a.keyword_id ?? null, articleId: a.id, term: a.keyword, organicUrls: row ? storedSerp(row.opportunity) : null, stage });
  }
  for (const p of sources.pages) {
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
export async function readIntentLeaders(supabase: SupabaseClient, workspaceId: string, onCalendar: OnCalendar): Promise<IntentLeader[]> {
  // Paged (lib/supabase/read-all.ts): the server hands back 1,000 rows at
  // most and says nothing, and a site with more pages than that compared its
  // candidates against the first thousand.
  const [keywords, articles, pages, entries] = await Promise.all([
    readAll<KeywordRow>((from, to) =>
      supabase
        .from("keywords")
        .select("id, term, status, opportunity")
        .eq("workspace_id", workspaceId)
        .in("status", ["planned", "drafting", "scheduled", "shipped"])
        .order("id")
        .range(from, to),
    ),
    readAll<ArticleRow>((from, to) =>
      supabase
        .from("articles")
        .select("id, keyword, keyword_id, status")
        .eq("workspace_id", workspaceId)
        .not("keyword", "is", null)
        .order("id")
        .range(from, to),
    ),
    readAll<PageRow>((from, to) =>
      supabase
        .from("site_pages")
        .select("url, keyword")
        .eq("workspace_id", workspaceId)
        .not("keyword", "is", null)
        .order("id")
        .range(from, to),
    ),
    readAll<EntryRow>((from, to) =>
      supabase
        .from("calendar_entries")
        .select("keyword_id, scheduled_date")
        .eq("workspace_id", workspaceId)
        .in("status", ["queue", "scheduled"])
        .order("id")
        .range(from, to),
    ),
  ]);
  for (const [what, res] of [["keywords", keywords], ["articles", articles], ["site pages", pages], ["calendar entries", entries]] as const) {
    if (res.error) throw new Error(`Could not read ${what} to check for duplicate topics: ${res.error.message}`);
  }
  const rows = (keywords.data ?? []) as KeywordRow[];
  // The row an article was written for carries the results page bought for
  // it; read it whatever its status, or the article compares by words alone
  // and a synonym of it gets past.
  const have = new Set(rows.map((r) => r.id));
  const missing = [...new Set(((articles.data ?? []) as ArticleRow[]).map((a) => a.keyword_id).filter((id): id is string => Boolean(id && !have.has(id))))];
  if (missing.length) {
    const more = await supabase.from("keywords").select("id, term, status, opportunity").eq("workspace_id", workspaceId).in("id", missing);
    if (more.error) throw new Error(`Could not read keywords to check for duplicate topics: ${more.error.message}`);
    rows.push(...((more.data ?? []) as KeywordRow[]));
  }
  return leadersFrom({
    keywords: rows,
    articles: (articles.data ?? []) as ArticleRow[],
    pages: (pages.data ?? []) as PageRow[],
    entries: (entries.data ?? []) as EntryRow[],
  }, onCalendar);
}

/** "already drafted", "already live", "on the calendar": how far the leader got, for a reason line. */
export function stageWords(stage: IntentStage): string {
  return stage === "live" ? "already live" : stage === "drafted" ? "already drafted" : stage === "scheduled" ? "on the calendar" : "approved and next in the queue";
}
