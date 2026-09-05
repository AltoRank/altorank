// ---------------------------------------------------------------------------
// Moving and removing planned keywords
// ---------------------------------------------------------------------------
//
// The two edits a person makes to a planned keyword from the calendar, on a
// plain SupabaseClient so the server action (app/actions/plan.ts) and the
// agent API (app/api/agent/v1/keywords/bulk-*) run the same code. Every write
// names the workspace as well as the row: the service-role client the agent
// API holds has no RLS behind it, and the cookie client's RLS is agency-wide,
// so in neither case is the id alone enough. See AGENTS.md.
//
// Only an entry with no article can be moved or removed. Once written, the
// article is the record and is managed from the Articles page.
//
// Nothing here publishes, approves or deletes a keyword. Removing takes the
// entry off the calendar; the keyword stays tracked, stamped so the planner
// does not put it straight back.

import type { SupabaseClient } from "@supabase/supabase-js";

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

/** `date` moved by `days` (negative allowed), as an ISO date. */
export function shiftIsoDate(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export type PlannedEntryRow = {
  id: string;
  keyword_id: string | null;
  keyword: string | null;
  article_id: string | null;
  scheduled_date: string;
  status: string;
};

/**
 * Take a planned keyword off the calendar. The entry goes; the keyword stays
 * tracked, stamped so the planner does not put it straight back.
 */
export async function removePlannedEntry(
  supabase: SupabaseClient,
  workspaceId: string,
  entryId: string,
): Promise<{ keywordId: string | null }> {
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
  const keywordId = (entry.keyword_id as string | null) ?? null;
  if (keywordId) {
    await supabase
      .from("keywords")
      .update({ plan_excluded_at: new Date().toISOString() })
      .eq("id", keywordId)
      .eq("workspace_id", workspaceId);
  }
  return { keywordId };
}

/**
 * Take several entries off the plan in two statements. Callers have already
 * checked none has an article. Same semantics as the single remove: the
 * entries go, their keywords stay tracked and are stamped.
 */
export async function removePlannedEntries(
  supabase: SupabaseClient,
  workspaceId: string,
  entries: Array<{ id: string; keyword_id: string | null }>,
): Promise<void> {
  if (entries.length === 0) return;
  const { error } = await supabase
    .from("calendar_entries")
    .delete()
    .eq("workspace_id", workspaceId)
    .in("id", entries.map((x) => x.id));
  if (error) throw new Error(error.message);
  const keywordIds = entries.map((x) => x.keyword_id).filter((id): id is string => Boolean(id));
  if (keywordIds.length) {
    await supabase
      .from("keywords")
      .update({ plan_excluded_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .in("id", keywordIds);
  }
}

/** Move a planned entry to another day. */
export async function reschedulePlannedEntry(
  supabase: SupabaseClient,
  workspaceId: string,
  entryId: string,
  date: string,
): Promise<void> {
  if (!isIsoDate(date)) throw new Error("Pick a date.");
  const { error, count } = await supabase
    .from("calendar_entries")
    .update({ scheduled_date: date }, { count: "exact" })
    .eq("id", entryId)
    .eq("workspace_id", workspaceId)
    .is("article_id", null);
  if (error) throw new Error(error.message);
  if (!count) throw new Error("This entry cannot be moved.");
}

/**
 * The unwritten planned entry for each of several keywords, keyed by keyword
 * id. A keyword with no queued entry is simply absent: it is not on the plan.
 */
export async function plannedEntriesForKeywords(
  supabase: SupabaseClient,
  workspaceId: string,
  keywordIds: string[],
): Promise<Map<string, PlannedEntryRow>> {
  const out = new Map<string, PlannedEntryRow>();
  if (!keywordIds.length) return out;
  const { data, error } = await supabase
    .from("calendar_entries")
    .select("id, keyword_id, keyword, article_id, scheduled_date, status")
    .eq("workspace_id", workspaceId)
    .in("keyword_id", keywordIds)
    .order("scheduled_date", { ascending: true });
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as PlannedEntryRow[]) {
    // Newest plan wins only if nothing is there yet; the first (earliest) row
    // per keyword is the one the calendar shows.
    if (row.keyword_id && !out.has(row.keyword_id)) out.set(row.keyword_id, row);
  }
  return out;
}

export type BulkOutcome = {
  keyword_id: string;
  entry_id: string | null;
  ok: boolean;
  /** Why this one was skipped. Absent when ok. */
  reason?: string;
};

export type RescheduleOutcome = BulkOutcome & { from: string | null; to: string | null };

export type RescheduleRequest =
  | { items: { keyword_id: string; date: string }[] }
  | { keyword_ids: string[]; shift_days: number };

/**
 * Move several planned keywords, either each to a named day or all by the
 * same number of days. One keyword failing does not stop the rest; the
 * outcome list says which moved and why the others did not.
 */
export async function bulkReschedule(
  supabase: SupabaseClient,
  workspaceId: string,
  request: RescheduleRequest,
): Promise<RescheduleOutcome[]> {
  const targets: { keyword_id: string; date: string | null; shift: number | null }[] =
    "items" in request
      ? request.items.map((i) => ({ keyword_id: i.keyword_id, date: i.date, shift: null }))
      : request.keyword_ids.map((keyword_id) => ({ keyword_id, date: null, shift: request.shift_days }));

  const entries = await plannedEntriesForKeywords(supabase, workspaceId, targets.map((t) => t.keyword_id));
  const out: RescheduleOutcome[] = [];
  for (const t of targets) {
    const entry = entries.get(t.keyword_id);
    if (!entry) {
      out.push({ keyword_id: t.keyword_id, entry_id: null, from: null, to: null, ok: false, reason: "Not on the plan." });
      continue;
    }
    if (entry.article_id) {
      out.push({ keyword_id: t.keyword_id, entry_id: entry.id, from: entry.scheduled_date, to: null, ok: false, reason: "Already written; the article is managed from Articles." });
      continue;
    }
    const to = t.date ?? shiftIsoDate(entry.scheduled_date, t.shift ?? 0);
    if (!isIsoDate(to)) {
      out.push({ keyword_id: t.keyword_id, entry_id: entry.id, from: entry.scheduled_date, to, ok: false, reason: "Not a valid date (YYYY-MM-DD)." });
      continue;
    }
    try {
      await reschedulePlannedEntry(supabase, workspaceId, entry.id, to);
      out.push({ keyword_id: t.keyword_id, entry_id: entry.id, from: entry.scheduled_date, to, ok: true });
    } catch (err) {
      out.push({ keyword_id: t.keyword_id, entry_id: entry.id, from: entry.scheduled_date, to, ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * Take several planned keywords off the calendar. Same semantics as the
 * planner's Remove, per keyword: entry deleted, keyword kept and stamped.
 */
export async function bulkRemove(
  supabase: SupabaseClient,
  workspaceId: string,
  keywordIds: string[],
): Promise<BulkOutcome[]> {
  const entries = await plannedEntriesForKeywords(supabase, workspaceId, keywordIds);
  const out: BulkOutcome[] = [];
  for (const keyword_id of keywordIds) {
    const entry = entries.get(keyword_id);
    if (!entry) {
      out.push({ keyword_id, entry_id: null, ok: false, reason: "Not on the plan." });
      continue;
    }
    if (entry.article_id) {
      out.push({ keyword_id, entry_id: entry.id, ok: false, reason: "Already written; the article is managed from Articles." });
      continue;
    }
    try {
      await removePlannedEntry(supabase, workspaceId, entry.id);
      out.push({ keyword_id, entry_id: entry.id, ok: true });
    } catch (err) {
      out.push({ keyword_id, entry_id: entry.id, ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
