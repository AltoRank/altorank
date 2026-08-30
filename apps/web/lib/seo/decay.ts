import type { SupabaseClient } from "@supabase/supabase-js";

export interface DecayingArticle {
  articleId: string;
  keyword: string;
  title: string;
  currentPosition: number;
  peakPosition: number;
  decline: number;
  peakDate: string;
}

/**
 * Detect articles with declining rankings.
 * Compares most recent rank vs peak rank in the last 90 days.
 * An article is "decaying" if it dropped 5+ positions from peak.
 */
export async function detectDecay(
  supabase: SupabaseClient,
  workspaceId: string,
  threshold = 5,
): Promise<DecayingArticle[]> {
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  // Fetch keywords with their rankings from last 90 days
  const { data: keywords } = await supabase
    .from("keywords")
    .select("id, term, workspace_id")
    .eq("workspace_id", workspaceId);

  if (!keywords?.length) return [];

  const keywordIds = keywords.map((k) => k.id);

  const { data: rankings } = await supabase
    .from("keyword_rankings")
    .select("keyword_id, position, checked_at")
    .in("keyword_id", keywordIds)
    .gte("checked_at", ninetyDaysAgo.toISOString())
    .gt("position", 0)
    .order("checked_at", { ascending: false });

  if (!rankings?.length) return [];

  // Fetch articles tied to these keywords
  const { data: articles } = await supabase
    .from("articles")
    .select("id, keyword, title")
    .eq("workspace_id", workspaceId)
    .in("status", ["live", "review"]);

  const articleMap = new Map(
    (articles ?? []).map((a) => [a.keyword?.toLowerCase(), a]),
  );

  // Group rankings by keyword
  const byKeyword = new Map<string, typeof rankings>();
  for (const r of rankings) {
    const list = byKeyword.get(r.keyword_id) ?? [];
    list.push(r);
    byKeyword.set(r.keyword_id, list);
  }

  const decaying: DecayingArticle[] = [];

  for (const kw of keywords) {
    const kwRankings = byKeyword.get(kw.id);
    if (!kwRankings || kwRankings.length < 2) continue;

    // Most recent position
    const current = kwRankings[0].position;

    // Peak (lowest position number = best)
    let peak = Infinity;
    let peakDate = "";
    for (const r of kwRankings) {
      if (r.position < peak) {
        peak = r.position;
        peakDate = r.checked_at;
      }
    }

    const decline = current - peak;
    if (decline >= threshold) {
      const article = articleMap.get(kw.term.toLowerCase());
      decaying.push({
        articleId: article?.id ?? "",
        keyword: kw.term,
        title: article?.title ?? kw.term,
        currentPosition: current,
        peakPosition: peak,
        decline,
        peakDate,
      });
    }
  }

  // Sort by worst decline first
  return decaying.sort((a, b) => b.decline - a.decline);
}
