import type { SupabaseClient } from "@supabase/supabase-js";
import { getQuota } from "@/lib/billing/quota";
import { sweepStaleDrafts } from "@/lib/content/stale-drafts";
import { generateArticle } from "@/lib/content/generate";
import { paceOnActivation } from "@/lib/content/pace";
import { selfInvocation, selfInvoke } from "@/lib/content/fan-out";
import { schedulePlan, fulfilPlannedEntry } from "./plan";
import { DAY_MS, isoDate } from "./plan-calendar";

export async function wakeFirstMonth(workspaceId: string): Promise<void> {
  const how = selfInvocation();
  if ("skipped" in how) return;
  const response = await selfInvoke("/api/internal/first-month", { workspaceId }, how);
  if (!response.ok) throw new Error(`First-month dispatch failed (${response.status})`);
}

/** Called only after trusted activation has persisted. Upsert never resets work. */
export async function queueFirstMonth(db: SupabaseClient, accountId: string, plan?: string): Promise<string[]> {
  const { data: sites, error } = await db.from("workspaces").select("id, auto_generate_weekly_limit").eq("account_id", accountId);
  if (error) throw error;
  const queued: string[] = [];
  for (const site of sites ?? []) {
    const existing = await db.from("first_month_runs").select("workspace_id").eq("workspace_id", site.id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) { queued.push(site.id); continue; }
    const pace = paceOnActivation(site.auto_generate_weekly_limit, plan);
    if (pace !== null) {
      const saved = await db.from("workspaces").update({ auto_generate_weekly_limit: pace }).eq("id", site.id).eq("account_id", accountId);
      if (saved.error) throw saved.error;
    }
    const preview = await db.from("onboarding_runs").select("article_id").eq("workspace_id", site.id).not("article_id", "is", null).limit(1).maybeSingle();
    if (preview.error) throw preview.error;
    if (!preview.data) continue;
    const saved = await db.from("first_month_runs").upsert({ workspace_id: site.id }, { onConflict: "workspace_id", ignoreDuplicates: true });
    if (saved.error) throw saved.error;
    queued.push(site.id);
  }
  return queued;
}

/** One bounded unit per invocation. A ten-minute database lease outlives the
 * five-minute function. Completed articles are recovered before any retry. */
export async function prepareFirstMonthStep(db: SupabaseClient, workspaceId: string, token: string): Promise<void> {
  const patch = async (values: Record<string, unknown>) => {
    const terminal = ["ready", "attention", "blocked"].includes(String(values.status));
    const saved = await db.from("first_month_runs").update({ ...values, ...(terminal ? { lease: null, lease_until: null } : {}) }).eq("workspace_id", workspaceId).eq("lease", token);
    if (saved.error) throw saved.error;
  };
  let jobId: string | undefined;
  let attempts = 0;
  let continueWork = false;
  try {
    const runResult = await db.from("first_month_runs").select("*").eq("workspace_id", workspaceId).eq("lease", token).maybeSingle();
    if (runResult.error) throw runResult.error;
    const run = runResult.data;
    if (!run) return;
    // Finishing saved work needs no further quota; the final draft may have
    // consumed the last article in the account allowance.
    const next = run.planned ? await db.from("first_month_jobs").select("*").eq("workspace_id", workspaceId).in("status", ["queued", "writing"]).order("scheduled_date").order("id").limit(1).maybeSingle() : { data: null, error: null };
    if (next.error) throw next.error;
    if (run.planned && !next.data) {
      const failed = await db.from("first_month_jobs").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "failed");
      if (failed.error) throw failed.error;
      await patch({ status: failed.count ? "attention" : "ready", message: failed.count ? "Some drafts need another attempt. Your completed drafts are saved." : null });
      return;
    }
    const siteResult = await db.from("workspaces").select("account_id, auto_generate, auto_generate_weekly_limit").eq("id", workspaceId).single();
    if (siteResult.error) throw siteResult.error;
    const site = siteResult.data;
    const quota = await getQuota(db, site.account_id);
    if (quota.reason !== "plan" || !site.auto_generate || !site.auto_generate_weekly_limit || (quota.remaining !== null && quota.remaining <= 0)) {
      await patch({ status: "blocked", message: "Preparation is paused. Check your plan, available articles and writing pace in Settings." });
      return;
    }
    if (!run.planned) {
      attempts = run.planning_attempts + 1;
      if (attempts > 2) {
        await patch({ status: "attention", message: "Research could not finish. Retry preparation when you are ready." });
        return;
      }
      await patch({ status: "planning", planning_attempts: attempts, message: null });
      const from = new Date(`${run.starts_on}T00:00:00Z`);
      const end = isoDate(new Date(from.getTime() + 30 * DAY_MS));
      const existing = await db.from("calendar_entries").select("id").eq("workspace_id", workspaceId).eq("status", "queue").is("article_id", null).gte("scheduled_date", run.starts_on).lt("scheduled_date", end);
      if (existing.error) throw existing.error;
      // Existing queued entries also need quota. Never sell the account's
      // shared allowance as a separate allowance for each site.
      const cadence = await db.from("publishing_cadences").select("days_of_week").eq("workspace_id", workspaceId).maybeSingle();
      if (cadence.error) throw cadence.error;
      await schedulePlan(db, workspaceId, site.auto_generate_weekly_limit, {
        daysOfWeek: cadence.data?.days_of_week,
        mode: "fill-month", from, distinctTasks: true,
        maxEntries: Math.max(0, (quota.remaining ?? 60) - (existing.data?.length ?? 0)),
      });
      const entries = await db.from("calendar_entries").select("id, keyword_id, scheduled_date").eq("workspace_id", workspaceId).eq("status", "queue").is("article_id", null).gte("scheduled_date", run.starts_on).lt("scheduled_date", end).order("scheduled_date").limit(quota.remaining ?? 60);
      if (entries.error) throw entries.error;
      if (entries.data?.length) {
        const saved = await db.from("first_month_jobs").upsert(entries.data.map((entry) => ({ workspace_id: workspaceId, entry_id: entry.id, scheduled_date: entry.scheduled_date })), { onConflict: "workspace_id,entry_id", ignoreDuplicates: true });
        if (saved.error) throw saved.error;
      }
      await patch({ planned: true, status: "writing" });
      continueWork = true;
      return;
    }
    const job = next.data!;
    jobId = job.id;
    attempts = job.attempts + 1;
    const entryResult = await db.from("calendar_entries").select("id, keyword_id, keyword, article_id").eq("workspace_id", workspaceId).eq("id", job.entry_id).maybeSingle();
    if (entryResult.error) throw entryResult.error;
    const entry = entryResult.data;
    if (!entry?.keyword_id || !entry.keyword) throw new Error("This planned topic is no longer available.");
    // Recover a save whose response or calendar attachment was interrupted.
    const written = await db.from("articles").select("id").eq("workspace_id", workspaceId).eq("keyword_id", entry.keyword_id).in("status", ["review", "approved", "scheduled", "live"]).order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (written.error) throw written.error;
    let articleId = written.data?.id;
    if (!articleId) {
      if (attempts > 2) throw new Error("This draft did not finish after two attempts.");
      const keyword = await db.from("keywords").select("opportunity, plan_excluded_at").eq("workspace_id", workspaceId).eq("id", entry.keyword_id).single();
      if (keyword.error) throw keyword.error;
      if (keyword.data.plan_excluded_at || keyword.data.opportunity?.status !== "qualified") throw new Error("This topic needs stronger evidence before writing.");
      const saved = await db.from("first_month_jobs").update({ status: "writing", attempts }).eq("workspace_id", workspaceId).eq("id", job.id);
      if (saved.error) throw saved.error;
      await sweepStaleDrafts(db, workspaceId);
      const result = await generateArticle({ supabase: db, workspaceId, keywordId: entry.keyword_id, keyword: entry.keyword, autonomous: true, verifySourceClaims: true, billToAccountId: site.account_id });
      articleId = result.articleId;
    }
    await fulfilPlannedEntry(db, entry.id, articleId);
    const saved = await db.from("first_month_jobs").update({ status: "ready", article_id: articleId }).eq("workspace_id", workspaceId).eq("id", job.id);
    if (saved.error) throw saved.error;
    continueWork = true;
  } catch (error) {
    console.error("[first-month]", error instanceof Error ? error.message : "Preparation failed");
    if (jobId) {
      const saved = await db.from("first_month_jobs").update({ status: attempts >= 2 ? "failed" : "queued", attempts }).eq("workspace_id", workspaceId).eq("id", jobId);
      if (saved.error) throw saved.error;
      continueWork = true;
    } else {
      await patch({ status: attempts >= 2 ? "attention" : "queued", message: "Research was interrupted. Your first draft is saved." });
      continueWork = attempts < 2;
    }
  } finally {
    await patch({ lease: null, lease_until: null });
    if (continueWork) await wakeFirstMonth(workspaceId);
  }
}
