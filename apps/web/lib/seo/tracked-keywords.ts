// ---------------------------------------------------------------------------
// Which keywords the nightly rank check buys a SERP for
// ---------------------------------------------------------------------------
//
// One function, read by cron/serp (which buys the SERPs) and by anything that
// tells a customer a term is being tracked (lib/publishing/on-article-live.ts),
// so the promise and the purchase cannot drift apart.
//
// Track what someone chose, not everything discovery ever found. Discovery
// writes a thousand rows per domain, and a thousand daily SERP checks is
// roughly $2-3/day against a €69 plan, spent mostly on terms nobody is
// targeting. Planned and shipped are the terms a person picked; the article
// keywords are the ones the product wrote for. The cap is a backstop, newest
// first, and is logged by the cron when it bites.
//
// Not the account gate: cron/serp skips accounts that are not entitled to
// scheduled work (entitledToScheduledWork) and paused workspaces before it
// gets here. `wouldTrackNightly` below applies both.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Keyword } from "@/lib/types";

export const TRACK_CAP = 200;

export async function selectTrackedKeywords(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<{ keywords: Keyword[]; error?: string }> {
  const { data: articleKw } = await supabase.from("articles").select("keyword").eq("workspace_id", workspaceId);
  const rawTerms = (articleKw ?? [])
    .map((a) => (typeof a.keyword === "string" ? a.keyword.trim() : ""))
    .filter((t) => t.length > 0);

  const { data: kwData, error: kwError } = await supabase
    .from("keywords")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("status", ["planned", "shipped"])
    // A term Search Console put in the pool gets its position from Search
    // Console, refreshed nightly by lib/gsc/seed.ts for free and for the
    // site's real audience rather than one SERP locale. Buying a SERP for it
    // would pay to know less. Null-safe on purpose: `source <> 'gsc'` alone is
    // NULL for a row with no source (pre-035 rows, the research drawer, the
    // "New article" modal, the found-live receipt) and dropped every one.
    .or("source.is.null,source.neq.gsc")
    .order("created_at", { ascending: false })
    .limit(TRACK_CAP);
  if (kwError) return { keywords: [], error: kwError.message };

  // Article keywords whose row is not planned or shipped still deserve
  // tracking: the product wrote a page for them. Matched as the article spells
  // the term and lowercased, since rows keep the case they were typed in.
  let keywords = (kwData ?? []) as Keyword[];
  const known = new Set(keywords.map((k) => k.term.toLowerCase()));
  if (keywords.length < TRACK_CAP && rawTerms.length > 0) {
    const missing = [...new Set(rawTerms.flatMap((t) => [t, t.toLowerCase()]))].filter(
      (t) => !known.has(t.toLowerCase()),
    );
    if (missing.length > 0) {
      const { data: extra } = await supabase
        .from("keywords")
        .select("*")
        .eq("workspace_id", workspaceId)
        .in("term", missing)
        .limit(TRACK_CAP - keywords.length);
      const seen = new Set(keywords.map((k) => k.id));
      keywords = keywords.concat(((extra ?? []) as Keyword[]).filter((k) => !seen.has(k.id)));
    }
  }
  return { keywords };
}

/**
 * Whether cron/serp, run tonight, would buy a SERP for this keyword row,
 * ignoring only the account's plan (the caller knows that already). The same
 * selection, not a copy of its rules.
 */
export async function wouldTrackNightly(
  supabase: SupabaseClient,
  workspace: { id: string; domain: string | null; status?: string | null },
  keywordId: string,
): Promise<{ tracked: true } | { tracked: false; why: string }> {
  if (workspace.status === "paused") return { tracked: false, why: "the site is paused" };
  if (!workspace.domain) return { tracked: false, why: "the site has no domain" };
  const { keywords, error } = await selectTrackedKeywords(supabase, workspace.id);
  if (error) return { tracked: false, why: `the tracked list could not be read: ${error}` };
  if (keywords.some((k) => k.id === keywordId)) return { tracked: true };
  return { tracked: false, why: `not in the site's ${TRACK_CAP} tracked keywords` };
}
