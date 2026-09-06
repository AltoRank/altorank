import { createClient } from "@/lib/supabase/server";
import type { ArticleFacts } from "@/lib/plan/card-state";

// ---------------------------------------------------------------------------
// The article side of every planner card
// ---------------------------------------------------------------------------
//
// A calendar entry names a day; the article it becomes carries the status the
// card should show. Both reads are by workspace as well as by id: an id list
// alone would let a stale entry pull an article from a sibling site.

export type ArticleStates = Map<string, NonNullable<ArticleFacts>>;

/** Status and live URL for the articles a set of entries point at. */
export async function getPlannerArticleStates(workspaceId: string, articleIds: string[]): Promise<ArticleStates> {
  const ids = [...new Set(articleIds.filter(Boolean))];
  const out: ArticleStates = new Map();
  if (ids.length === 0) return out;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("articles")
    .select("id, status, published_url")
    .eq("workspace_id", workspaceId)
    .in("id", ids);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Array<{ id: string; status: string; published_url: string | null }>) {
    out.set(row.id, { status: row.status, published_url: row.published_url });
  }
  return out;
}

/** A draft being written right now, and which half of the run it is in. */
export type InFlightDraft = {
  articleId: string;
  keywordId: string | null;
  /** Lower-cased term, for entries whose keyword row is gone. */
  term: string;
  createdAt: string;
  phase: "research" | "drafting";
};

/**
 * Every draft in flight for a workspace. The planner matches these to entries
 * with no article yet - `writeNow` links the two only when the run succeeds -
 * so the card can read "Writing…" while the writer works. The phase comes
 * from the running job, which `writeNow` stamps once research is over; a job
 * with no stamp is still researching.
 */
export async function getDraftsInFlight(workspaceId: string): Promise<InFlightDraft[]> {
  const supabase = await createClient();
  // Both reads are scoped by workspace on their own, so they need not wait on
  // each other: the running jobs for one site are the handful being written
  // right now, and matching them to the drafting articles is done here.
  const [{ data, error }, { data: jobs }] = await Promise.all([
    supabase
      .from("articles")
      .select("id, keyword_id, keyword, created_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "drafting"),
    supabase
      .from("generation_jobs")
      .select("article_id, result")
      .eq("workspace_id", workspaceId)
      .eq("status", "running"),
  ]);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: string; keyword_id: string | null; keyword: string | null; created_at: string }>;
  if (rows.length === 0) return [];

  const drafting = new Set(rows.map((r) => r.id));
  const phaseByArticle = new Map<string, "research" | "drafting">();
  for (const j of (jobs ?? []) as Array<{ article_id: string | null; result: unknown }>) {
    if (!j.article_id || !drafting.has(j.article_id)) continue;
    const phase = (j.result as { phase?: unknown } | null)?.phase;
    phaseByArticle.set(j.article_id, phase === "drafting" ? "drafting" : "research");
  }

  return rows.map((r) => ({
    articleId: r.id,
    keywordId: r.keyword_id,
    term: (r.keyword ?? "").trim().toLowerCase(),
    createdAt: r.created_at,
    phase: phaseByArticle.get(r.id) ?? "research",
  }));
}

/** The in-flight draft for one entry, by keyword row first and term second. */
export function inFlightFor(
  drafts: InFlightDraft[],
  entry: { keyword_id: string | null; keyword: string },
): InFlightDraft | null {
  if (entry.keyword_id) {
    const byId = drafts.find((d) => d.keywordId === entry.keyword_id);
    if (byId) return byId;
  }
  const term = entry.keyword.trim().toLowerCase();
  return drafts.find((d) => d.term === term) ?? null;
}
