// ---------------------------------------------------------------------------
// Write a planned keyword's article now rather than on its day
// ---------------------------------------------------------------------------
//
// Same path as the cron and the "New article" modal - `generateArticle`, with
// its quota gate - and the same destination: the draft lands in review, never
// anywhere else. The entry is linked to the article only once generation
// succeeds, so a failed run leaves the keyword planned and the button live;
// while the writer works, the planner finds the draft by keyword and shows
// the card as writing.
//
// Refused when the entry already has an article, when a draft for the keyword
// is already being written, when the entry is inactive under the plan
// (lib/plan/frozen.ts - the card does not offer the button, but the route is
// a door of its own), and - inside `generateArticle` - when the free draft is
// used. A paid plan at its limit is billed as overage, exactly as a manual
// generation is.
//
// One implementation, two doors: the `writeNow` server action and the
// POST /api/plan/write-now route. The card uses the route, because a server
// action that runs for minutes holds the router's action queue and blocks the
// `router.refresh()` the card polls with; a fetch does not.

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateArticle } from "@/lib/content/generate";
import { fulfilPlannedEntry } from "@/lib/onboarding/plan";
import { getQuota } from "@/lib/billing/quota";
import { readFrozenEntries } from "@/lib/plan/frozen";

export async function writePlannedEntryNow(
  supabase: SupabaseClient,
  workspaceId: string,
  entryId: string,
  /** Who is asking; `undefined` lets the quota gate resolve the session itself. */
  callerEmail: string | undefined,
): Promise<{ articleId: string }> {
  const { data: entry } = await supabase
    .from("calendar_entries")
    .select("id, keyword_id, keyword, article_id")
    .eq("id", entryId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!entry) throw new Error("This entry is not on the plan.");
  if (entry.article_id) throw new Error("This article has already been written; open it from the card.");
  const term = (entry.keyword as string | null)?.trim();
  if (!term) throw new Error("This entry has no keyword to write.");
  const keywordId = (entry.keyword_id as string | null) ?? undefined;

  // One draft at a time per keyword: a second click while the first run is
  // still writing would spend the quota twice for the same article.
  if (await draftingArticleFor(supabase, workspaceId, keywordId, term)) {
    throw new Error("This article is already being written.");
  }

  // Beyond the plan's allowance, in scheduled order? Then it is inactive and
  // the calendar says so; the same quota the writer's gate will consult.
  const { data: ws } = await supabase.from("workspaces").select("agency_id").eq("id", workspaceId).maybeSingle();
  if (ws?.agency_id) {
    const quota = await getQuota(supabase, ws.agency_id as string, callerEmail);
    const frozen = await readFrozenEntries(supabase, workspaceId, quota);
    if (frozen.ids.has(entry.id as string)) throw new Error(frozen.reason ?? "This keyword is inactive under the current plan.");
  }

  const result = await generateArticle({
    supabase,
    workspaceId,
    keyword: term,
    keywordId,
    // A person asked for it, from a screen. Not machine-chosen, and not
    // sessionless: the quota gate sees the caller, so an operator writing
    // from the planner is not metered as a customer would be.
    autonomous: false,
    callerEmail,
    // Research is over, the model is writing. Stamp the phase on the running
    // job so the card can say which half of the wait this is.
    onResearch: () => {
      void markDraftingPhase(supabase, workspaceId, keywordId, term);
    },
  });

  await fulfilPlannedEntry(supabase, entry.id as string, result.articleId);
  return { articleId: result.articleId };
}

/** The draft being written for a keyword in this workspace, if any. */
async function draftingArticleFor(
  supabase: SupabaseClient,
  workspaceId: string,
  keywordId: string | undefined,
  term: string,
): Promise<string | null> {
  let q = supabase
    .from("articles")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("status", "drafting")
    .order("created_at", { ascending: false })
    .limit(1);
  q = keywordId ? q.eq("keyword_id", keywordId) : q.ilike("keyword", term.replace(/[\\%_]/g, (c) => `\\${c}`));
  const { data } = await q.maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

async function markDraftingPhase(
  supabase: SupabaseClient,
  workspaceId: string,
  keywordId: string | undefined,
  term: string,
): Promise<void> {
  const articleId = await draftingArticleFor(supabase, workspaceId, keywordId, term);
  if (!articleId) return;
  await supabase
    .from("generation_jobs")
    .update({ result: { phase: "drafting" } })
    .eq("workspace_id", workspaceId)
    .eq("article_id", articleId)
    .eq("status", "running");
}
