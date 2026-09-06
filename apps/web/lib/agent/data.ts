// ---------------------------------------------------------------------------
// Reads for the agent API, scoped by hand
// ---------------------------------------------------------------------------
//
// The agent context holds a service-role client, so RLS is not standing behind
// these queries. Every function here therefore names the agency, and the
// workspace-level ones name the workspace too - the rule AGENTS.md states for
// pages applies twice over here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Article, GenerationJob, Keyword, Workspace } from "@/lib/types";
import type { AgentContext } from "./auth";

export async function agencyWorkspaces(ctx: AgentContext): Promise<Workspace[]> {
  const { data, error } = await ctx.supabase
    .from("workspaces")
    .select("*")
    .eq("agency_id", ctx.agencyId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Workspace[];
}

/** The workspace, if it belongs to the key's account. Null otherwise - the same answer for "not yours" and "not there". */
export async function workspaceInAgency(ctx: AgentContext, workspaceId: string): Promise<Workspace | null> {
  const { data } = await ctx.supabase
    .from("workspaces")
    .select("*")
    .eq("id", workspaceId)
    .eq("agency_id", ctx.agencyId)
    .maybeSingle();
  return (data as Workspace | null) ?? null;
}

export async function listKeywords(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { status?: string; limit: number },
): Promise<Keyword[]> {
  let query = supabase
    .from("keywords")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("volume", { ascending: false, nullsFirst: false })
    .limit(opts.limit);
  if (opts.status) query = query.eq("status", opts.status);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Keyword[];
}

/**
 * The planned day for every unwritten keyword on the workspace's calendar,
 * keyed by keyword id. What `planned_for` on a keyword record reads.
 */
export async function plannedDatesFor(supabase: SupabaseClient, workspaceId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("calendar_entries")
    .select("keyword_id, scheduled_date")
    .eq("workspace_id", workspaceId)
    .eq("status", "queue")
    .is("article_id", null)
    .order("scheduled_date", { ascending: true });
  if (error) throw new Error(error.message);
  const out = new Map<string, string>();
  for (const r of (data ?? []) as { keyword_id: string | null; scheduled_date: string }[]) {
    if (r.keyword_id && !out.has(r.keyword_id)) out.set(r.keyword_id, r.scheduled_date);
  }
  return out;
}

export async function listArticles(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { status?: string; limit: number },
): Promise<Article[]> {
  let query = supabase
    .from("articles")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .limit(opts.limit);
  if (opts.status) query = query.eq("status", opts.status);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Article[];
}

/** An article by id, only if its workspace is in the key's account. */
export async function articleInAgency(ctx: AgentContext, articleId: string): Promise<Article | null> {
  const { data } = await ctx.supabase
    .from("articles")
    .select("*, workspace:workspaces!inner(agency_id)")
    .eq("id", articleId)
    .eq("workspace.agency_id", ctx.agencyId)
    .maybeSingle();
  if (!data) return null;
  const { workspace: _workspace, ...article } = data as Article & { workspace: unknown };
  void _workspace;
  return article as Article;
}

export async function latestJob(
  supabase: SupabaseClient,
  workspaceId: string,
  articleId: string,
): Promise<Pick<GenerationJob, "id" | "status" | "error" | "started_at" | "completed_at"> | null> {
  const { data } = await supabase
    .from("generation_jobs")
    .select("id, status, error, started_at, completed_at")
    .eq("workspace_id", workspaceId)
    .eq("article_id", articleId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export type IntegrationStatus = { id: string; name: string; tag: string; connected: boolean };

/** Every integration AltoRank knows, marked connected or not for this workspace. */
export async function integrationStatus(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<IntegrationStatus[]> {
  const [{ data: all }, { data: connected }] = await Promise.all([
    supabase.from("integrations").select("id, name, tag").order("name"),
    supabase.from("workspace_integrations").select("integration_id").eq("workspace_id", workspaceId),
  ]);
  const on = new Set((connected ?? []).map((r) => r.integration_id as string));
  return ((all ?? []) as { id: string; name: string; tag: string }[]).map((i) => ({
    ...i,
    connected: on.has(i.id),
  }));
}

/** Articles created this calendar month, per workspace. What the quota counts. */
export async function articlesThisMonth(
  supabase: SupabaseClient,
  workspaceIds: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = Object.fromEntries(workspaceIds.map((id) => [id, 0]));
  if (!workspaceIds.length) return counts;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data } = await supabase
    .from("articles")
    .select("workspace_id")
    .in("workspace_id", workspaceIds)
    .gte("created_at", monthStart);
  for (const row of data ?? []) counts[row.workspace_id] = (counts[row.workspace_id] ?? 0) + 1;
  return counts;
}
