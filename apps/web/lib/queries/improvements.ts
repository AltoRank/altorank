import { createClient } from "@/lib/supabase/server";
import type { Opportunity, TaskStatus } from "@/lib/refresh/types";

// ---------------------------------------------------------------------------
// The improvements a month's calendar shows
// ---------------------------------------------------------------------------
//
// A refresh task is a decision to rewrite a page on a date. It has always been
// listed on the Improvements page and never drawn on the calendar, although
// it spends one of the calendar's slots. This reads the month's tasks for one
// site, with enough of the candidate to label the square (the page, the
// reason) and, once the rewrite has run, the execution to open.

export type PlannerImprovement = {
  taskId: string;
  candidateId: string;
  workspaceId: string;
  /** `YYYY-MM-DD` */
  scheduledFor: string;
  status: TaskStatus;
  createdAt: string;
  url: string;
  /** Article or crawled-page title; the URL's path when neither is known. */
  title: string;
  opportunity: Opportunity;
  /** The rewrite awaiting review, once the task has run. */
  executionId: string | null;
};

type TaskRow = {
  id: string;
  candidate_id: string;
  workspace_id: string;
  scheduled_for: string;
  status: TaskStatus;
  created_at: string;
  candidate:
    | {
        url: string;
        opportunity: Opportunity;
        article: { title: string | null } | { title: string | null }[] | null;
        site_page: { title: string | null } | { title: string | null }[] | null;
      }
    | null;
  executions: Array<{ id: string; created_at: string }> | null;
};

function first<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * Tasks scheduled in `month` (`YYYY-MM`) for a workspace, cancelled ones
 * excluded: a cancelled task is a decision withdrawn, not a square.
 */
export async function getPlannerImprovements(workspaceId: string, month: string): Promise<PlannerImprovement[]> {
  const [y, m] = month.split("-").map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return [];
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("refresh_tasks")
    .select(
      "id, candidate_id, workspace_id, scheduled_for, status, created_at, " +
        "candidate:refresh_candidates(url, opportunity, article:articles(title), site_page:site_pages(title)), " +
        "executions:refresh_executions(id, created_at)",
    )
    .eq("workspace_id", workspaceId)
    .in("status", ["scheduled", "running", "done", "failed"])
    .gte("scheduled_for", start)
    .lt("scheduled_for", next)
    .order("scheduled_for", { ascending: true });
  if (error) throw new Error(error.message);

  const out: PlannerImprovement[] = [];
  for (const row of (data ?? []) as unknown as TaskRow[]) {
    const cand = row.candidate;
    if (!cand) continue;
    const title =
      first(cand.article)?.title || first(cand.site_page)?.title || cand.url.replace(/^https?:\/\/[^/]+/, "") || cand.url;
    const latest = [...(row.executions ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
    out.push({
      taskId: row.id,
      candidateId: row.candidate_id,
      workspaceId: row.workspace_id,
      scheduledFor: row.scheduled_for,
      status: row.status,
      createdAt: row.created_at,
      url: cand.url,
      title,
      opportunity: cand.opportunity,
      executionId: latest?.id ?? null,
    });
  }
  return out;
}
