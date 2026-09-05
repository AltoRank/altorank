import type { Metadata } from "next";
import { PageHead, DotSep } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { getDestinations } from "@/lib/publishing/destinations";
import { UPDATABLE_CMS } from "@/lib/refresh/push";
import { plural } from "@/lib/utils";
import {
  ImprovementsView,
  type CandidateRow,
  type ExecutionRow,
} from "@/components/dashboard/improvements/improvements-view";
import type { RefreshCandidate, RefreshExecution, RefreshTask } from "@/lib/refresh/types";

export const metadata: Metadata = { title: "Improvements" };

/**
 * Rewrites of pages that already rank, waiting for a yes.
 *
 * One site at a time, like every operational page: the switcher decides which.
 * Three reads, all scoped: what the detectors found, what was scheduled, and
 * what the rewrites produced. The blockers at the top say what cannot happen
 * without Search Console or a CMS, in those terms, because an empty table
 * under a working feature and an empty table under a missing connection look
 * the same and mean opposite things.
 */
export default async function ImprovementsPage() {
  const scopeId = await getScopedWorkspaceId();
  if (!scopeId) {
    return <div className="p-8 text-ink-3">No site yet. Add one to start finding pages to improve.</div>;
  }
  const supabase = await createClient();

  const [{ data: ws }, { data: gsc }, destinations, { data: candidates }, { data: tasks }, { data: executions }] =
    await Promise.all([
      supabase
        .from("workspaces")
        .select("id, domain, refresh_enabled, refresh_days, refresh_last_analyzed_at")
        .eq("id", scopeId)
        .maybeSingle(),
      supabase
        .from("workspace_integrations")
        .select("id")
        .eq("workspace_id", scopeId)
        .eq("integration_id", "gsc")
        .not("tokens", "is", null)
        .limit(1),
      getDestinations(supabase, scopeId),
      supabase
        .from("refresh_candidates")
        .select("*")
        .eq("workspace_id", scopeId)
        .is("dismissed_at", null)
        .order("created_at", { ascending: false }),
      supabase
        .from("refresh_tasks")
        .select("*")
        .eq("workspace_id", scopeId)
        .in("status", ["scheduled", "running", "failed"]),
      supabase
        .from("refresh_executions")
        .select("id, task_id, workspace_id, review_status, created_at, pushed_at, published_url, validation_issues, hunks, task:refresh_tasks(candidate_id, candidate:refresh_candidates(url, opportunity, article_id, site_page_id))")
        .eq("workspace_id", scopeId)
        .order("created_at", { ascending: false }),
    ]);

  // Titles for the Article column: our own articles, or the crawled page.
  const articleIds = new Set<string>();
  const pageIds = new Set<string>();
  for (const c of (candidates ?? []) as RefreshCandidate[]) {
    if (c.article_id) articleIds.add(c.article_id);
    if (c.site_page_id) pageIds.add(c.site_page_id);
  }
  for (const e of executions ?? []) {
    const cand = (e.task as { candidate?: { article_id?: string | null; site_page_id?: string | null } } | null)?.candidate;
    if (cand?.article_id) articleIds.add(cand.article_id);
    if (cand?.site_page_id) pageIds.add(cand.site_page_id);
  }
  const [{ data: articles }, { data: pages }] = await Promise.all([
    articleIds.size
      ? supabase.from("articles").select("id, title").eq("workspace_id", scopeId).in("id", [...articleIds])
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
    pageIds.size
      ? supabase.from("site_pages").select("id, title").eq("workspace_id", scopeId).in("id", [...pageIds])
      : Promise.resolve({ data: [] as { id: string; title: string | null }[] }),
  ]);
  const titleOf = (articleId: string | null, pageId: string | null, url: string): string =>
    (articleId && (articles ?? []).find((a) => a.id === articleId)?.title) ||
    (pageId && (pages ?? []).find((p) => p.id === pageId)?.title) ||
    url.replace(/^https?:\/\/[^/]+/, "") ||
    url;

  const taskByCandidate = new Map<string, RefreshTask>();
  for (const t of (tasks ?? []) as RefreshTask[]) taskByCandidate.set(t.candidate_id, t);

  const candidateRows: CandidateRow[] = ((candidates ?? []) as RefreshCandidate[]).map((c) => ({
    ...c,
    title: titleOf(c.article_id, c.site_page_id, c.url),
    task: taskByCandidate.get(c.id) ?? null,
  }));

  const executionRows: ExecutionRow[] = (executions ?? []).map((e) => {
    const cand = (e.task as { candidate?: { url: string; opportunity: string; article_id: string | null; site_page_id: string | null } } | null)?.candidate;
    const hunks = (e.hunks as RefreshExecution["hunks"]) ?? [];
    return {
      id: e.id as string,
      review_status: e.review_status as RefreshExecution["review_status"],
      created_at: e.created_at as string,
      pushed_at: (e.pushed_at as string | null) ?? null,
      published_url: (e.published_url as string | null) ?? null,
      url: cand?.url ?? "",
      opportunity: (cand?.opportunity ?? "thin") as ExecutionRow["opportunity"],
      title: cand ? titleOf(cand.article_id, cand.site_page_id, cand.url) : "(page removed)",
      changed: hunks.filter((h) => h.kind !== "unchanged").length,
      issues: ((e.validation_issues as unknown[]) ?? []).length,
    };
  });

  const awaiting = executionRows.filter((e) => e.review_status === "awaiting_review").length;
  const updatable = destinations.filter((d) => UPDATABLE_CMS.has(d.type));

  return (
    <>
      <PageHead
        title="Improvements"
        subtitle={
          <>
            <span>{plural(awaiting, "rewrite")} awaiting review</span>
            {ws?.domain ? (
              <>
                <DotSep />
                <span className="font-mono text-[11.5px]">{ws.domain as string}</span>
              </>
            ) : null}
          </>
        }
      />
      <ImprovementsView
        workspaceId={scopeId}
        gscConnected={Boolean(gsc?.length)}
        cms={{
          connected: destinations.length > 0,
          labels: destinations.map((d) => d.label),
          updatable: updatable.length > 0,
        }}
        refresh={{
          enabled: Boolean(ws?.refresh_enabled),
          days: ((ws?.refresh_days as number[] | null) ?? []),
          lastAnalyzedAt: (ws?.refresh_last_analyzed_at as string | null) ?? null,
        }}
        candidates={candidateRows}
        executions={executionRows}
      />
    </>
  );
}
