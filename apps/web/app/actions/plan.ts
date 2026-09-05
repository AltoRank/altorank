"use server";

// ---------------------------------------------------------------------------
// Editing the plan
// ---------------------------------------------------------------------------
//
// Everything a person can do to a planned keyword from the calendar: tell the
// writer something, answer its questions, move the day, take it off the plan,
// or lay the month out. Every write names the caller's active workspace as
// well as the row id: the id alone is enough for RLS (agency scope) and not
// enough for the page (workspace scope). See AGENTS.md.
//
// Nothing here publishes or approves anything. `writeNow` writes, into review.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { countScheduled, ensureQuestionsFor, schedulePlan, PLAN_MAX_ENTRIES } from "@/lib/onboarding/plan";
import { writePlannedEntryNow } from "@/lib/plan/write-now";
import { parseStoredQuestions, type QualityQuestion } from "@/lib/keywords/questions";
import { isExpectedLength } from "@/lib/keywords/taxonomy";
import { FREE_TIER_PACE } from "@/lib/content/pace";

async function scoped() {
  const supabase = await createClient();
  const workspaceId = await getScopedWorkspaceId();
  if (!workspaceId) throw new Error("No workspace is selected.");
  return { supabase, workspaceId };
}

function refresh() {
  revalidatePath("/content");
  revalidatePath("/dashboard");
}

/** The free-text brief and the length band for one keyword's article. */
export async function saveKeywordBrief(
  keywordId: string,
  input: { instructions: string; expectedLength?: string },
): Promise<void> {
  const { supabase, workspaceId } = await scoped();
  const instructions = input.instructions.trim().slice(0, 4000) || null;
  const patch: Record<string, unknown> = { instructions };
  if (input.expectedLength !== undefined) {
    if (!isExpectedLength(input.expectedLength)) throw new Error("Unknown length.");
    patch.expected_length = input.expectedLength;
  }
  const { error } = await supabase
    .from("keywords")
    .update(patch)
    .eq("id", keywordId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
  refresh();
}

/**
 * Store answers by question id. Only the questions already on the row are
 * touched, so a client cannot add a question the model never asked, and a
 * blank answer clears rather than stores whitespace.
 */
export async function saveKeywordAnswers(
  keywordId: string,
  answers: Record<string, string>,
): Promise<QualityQuestion[]> {
  const { supabase, workspaceId } = await scoped();
  const { data, error } = await supabase
    .from("keywords")
    .select("quality_questions")
    .eq("id", keywordId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Keyword not found in this workspace.");

  const merged = parseStoredQuestions(data.quality_questions).map((q) => {
    if (!(q.id in answers)) return q;
    const a = (answers[q.id] ?? "").trim().slice(0, 2000);
    return { ...q, answer: a || null };
  });
  const { error: saveError } = await supabase
    .from("keywords")
    .update({ quality_questions: merged })
    .eq("id", keywordId)
    .eq("workspace_id", workspaceId);
  if (saveError) throw new Error(saveError.message);
  refresh();
  return merged;
}

/**
 * The questions for a keyword, generating them if the row has none. Returns
 * whatever is stored afterwards, which is still [] when generation could not
 * produce any: the dialog says so rather than showing invented ones.
 */
export async function ensureKeywordQuestions(keywordId: string): Promise<QualityQuestion[]> {
  const { supabase, workspaceId } = await scoped();
  const read = async () => {
    const { data } = await supabase
      .from("keywords")
      .select("id, term, quality_questions")
      .eq("id", keywordId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    return data as { id: string; term: string; quality_questions: unknown } | null;
  };
  const row = await read();
  if (!row) throw new Error("Keyword not found in this workspace.");
  const current = parseStoredQuestions(row.quality_questions);
  if (current.length > 0) return current;
  await ensureQuestionsFor(supabase, workspaceId, [{ id: row.id, term: row.term }]);
  const after = await read();
  const questions = parseStoredQuestions(after?.quality_questions);
  if (questions.length) refresh();
  return questions;
}

/**
 * Take a planned keyword off the calendar. The entry goes; the keyword stays
 * tracked, stamped so the planner does not put it straight back. Only an
 * entry with no article can be removed: once written, the article is the
 * record and is managed from the Articles page.
 */
export async function removePlannedEntry(entryId: string): Promise<void> {
  const { supabase, workspaceId } = await scoped();
  const { data: entry } = await supabase
    .from("calendar_entries")
    .select("id, keyword_id, article_id")
    .eq("id", entryId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!entry) throw new Error("This entry is not on the plan.");
  if (entry.article_id) throw new Error("This article has already been written; manage it from Articles.");

  const { error } = await supabase
    .from("calendar_entries")
    .delete()
    .eq("id", entryId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
  if (entry.keyword_id) {
    await supabase
      .from("keywords")
      .update({ plan_excluded_at: new Date().toISOString() })
      .eq("id", entry.keyword_id as string)
      .eq("workspace_id", workspaceId);
  }
  refresh();
}

/** Move a planned entry to another day. */
export async function reschedulePlannedEntry(entryId: string, date: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    throw new Error("Pick a date.");
  }
  const { supabase, workspaceId } = await scoped();
  const { error, count } = await supabase
    .from("calendar_entries")
    .update({ scheduled_date: date }, { count: "exact" })
    .eq("id", entryId)
    .eq("workspace_id", workspaceId)
    .is("article_id", null);
  if (error) throw new Error(error.message);
  if (!count) throw new Error("This entry cannot be moved.");
  refresh();
}

/**
 * Lay out the month for the active workspace at its own pace. Additive: it
 * keeps what is already on the calendar and fills the room left under the
 * cap, so pressing it twice does not reshuffle a plan someone has edited.
 */
export async function planMonth(): Promise<{ planned: number; scheduled: number; max: number }> {
  const { supabase, workspaceId } = await scoped();
  const { data: ws } = await supabase
    .from("workspaces")
    .select("auto_generate_weekly_limit")
    .eq("id", workspaceId)
    .maybeSingle();
  const pace = (ws?.auto_generate_weekly_limit as number | null) ?? FREE_TIER_PACE;
  const planned = await schedulePlan(supabase, workspaceId, pace, new Date(), { mode: "top-up" });
  refresh();
  return { planned: planned.length, scheduled: await countScheduled(supabase, workspaceId), max: PLAN_MAX_ENTRIES };
}

/**
 * Write a planned keyword's article now. The behaviour is lib/plan/write-now;
 * this is its server-action door. The planner card uses the route instead
 * (app/api/plan/write-now), for the reason given there.
 */
export async function writeNow(entryId: string): Promise<{ articleId: string }> {
  const { supabase, workspaceId } = await scoped();
  const { data: auth } = await supabase.auth.getUser();
  const result = await writePlannedEntryNow(supabase, workspaceId, entryId, auth.user?.email ?? undefined);
  refresh();
  revalidatePath("/articles");
  return result;
}
