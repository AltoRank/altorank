import { createClient } from "@/lib/supabase/server";
import type { CalendarEntry } from "@/lib/types";

/**
 * The publishing calendar, derived from the articles themselves.
 *
 * This read `calendar_entries`, a table nothing in the codebase has ever
 * written: the one `select` in this file was its only reference anywhere. So
 * the Calendar page and the workspace Calendar tab were empty for every
 * account, always, and that emptiness read as "you have no plan yet" rather
 * than "this view has no source".
 *
 * Articles already carry every date a calendar needs - `published_at` for what
 * shipped, `scheduled_at` for what is due, and a `drafting` status for what is
 * being written right now - so the calendar is a view of them rather than a
 * second copy that has to be kept in step with them.
 *
 * Only articles with a real date appear. Putting an undated one on an
 * arbitrary square would be inventing a commitment nobody made.
 */

type ArticleRow = {
  id: string;
  workspace_id: string;
  keyword: string | null;
  keyword_id: string | null;
  title: string | null;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
};

/** The day an article belongs on, and what it is doing there. */
function place(a: ArticleRow): { date: string; status: CalendarEntry["status"] } | null {
  if (a.status === "live") {
    // A live article with no published_at predates that column being written.
    // It still shipped, so date it by when it was made rather than drop it.
    return { date: a.published_at ?? a.created_at, status: "done" };
  }
  if (a.scheduled_at) return { date: a.scheduled_at, status: "scheduled" };
  if (a.status === "drafting") {
    // Being written now. The grid highlights `run`, which is what makes today
    // look different from every other square.
    return { date: a.created_at, status: "run" };
  }
  if (a.status === "approved") {
    // Approved and waiting for a slot: no date of its own, so it sits on the
    // day it was created and reads as queued.
    return { date: a.created_at, status: "queue" };
  }
  // draft, review, error, archived: not a calendar event.
  return null;
}

export async function getCalendarEntries(
  workspaceId?: string,
  month?: string,
): Promise<CalendarEntry[]> {
  const supabase = await createClient();

  let query = supabase
    .from("articles")
    .select("id, workspace_id, keyword, keyword_id, title, status, scheduled_at, published_at, created_at");

  if (workspaceId) query = query.eq("workspace_id", workspaceId);

  // Planned keywords with no article yet (used further down). Independent of
  // the articles read, so both go out together rather than one after the other.
  let planned = supabase
    .from("calendar_entries")
    .select("id, workspace_id, keyword, keyword_id, scheduled_date, status, created_at, article_id")
    .in("status", ["queue", "scheduled"]);
  if (workspaceId) planned = planned.eq("workspace_id", workspaceId);

  const [{ data, error }, { data: plannedRows }] = await Promise.all([query, planned]);
  if (error) throw new Error(error.message);

  // The month filter runs here rather than in SQL because which column holds
  // the date depends on the article's state, and a WHERE clause cannot ask
  // that without three OR branches that would drift from `place`.
  let start: number | null = null;
  let end: number | null = null;
  if (month) {
    const [y, m] = month.split("-").map(Number);
    start = Date.UTC(y, m - 1, 1);
    end = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
  }

  const entries: CalendarEntry[] = [];
  for (const a of (data ?? []) as ArticleRow[]) {
    const placed = place(a);
    if (!placed) continue;
    if (start !== null && end !== null) {
      const t = new Date(placed.date).getTime();
      if (Number.isNaN(t) || t < start || t >= end) continue;
    }
    entries.push({
      id: a.id,
      workspace_id: a.workspace_id,
      article_id: a.id,
      keyword_id: a.keyword_id ?? null,
      // The grid labels each square with the keyword; fall back to the title
      // so a hand-written article is not a blank chip.
      keyword: a.keyword || a.title || "Untitled",
      scheduled_date: placed.date,
      status: placed.status,
      created_at: a.created_at,
      planned: false,
    });
  }

  // Planned keywords with no article yet. The plan is the product's promise
  // for the month; a calendar that only showed what had already been written
  // was a history, not a plan.
  //
  // A planned entry whose article has been written stays on its planned day
  // too, unless the article already placed itself (scheduled, drafting,
  // approved, live): a draft sitting in review is otherwise invisible on the
  // very day the plan promised it.
  const placedArticles = new Set(entries.map((e) => e.article_id));
  type PlannedRow = { id: string; workspace_id: string; keyword: string | null; keyword_id: string | null; scheduled_date: string; created_at: string; article_id: string | null };
  for (const p of (plannedRows ?? []) as PlannedRow[]) {
    if (p.article_id && placedArticles.has(p.article_id)) continue;
    if (start !== null && end !== null) {
      const t = new Date(p.scheduled_date).getTime();
      if (Number.isNaN(t) || t < start || t >= end) continue;
    }
    entries.push({
      id: p.id,
      workspace_id: p.workspace_id,
      article_id: p.article_id,
      keyword_id: p.keyword_id ?? null,
      keyword: p.keyword || "Planned",
      scheduled_date: p.scheduled_date,
      status: p.article_id ? "scheduled" : "queue",
      created_at: p.created_at,
      planned: true,
    });
  }

  return entries.sort((x, y) => x.scheduled_date.localeCompare(y.scheduled_date));
}
