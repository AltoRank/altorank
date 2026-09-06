"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { analyzeWorkspace, headingsOf, type AnalyzeResult } from "@/lib/refresh/detect";
import { writeBrief } from "@/lib/refresh/brief";
import { loadPageBody } from "@/lib/refresh/rewrite";
import { pushExecution, exportExecution, type PushResult } from "@/lib/refresh/push";
import { recordSpend, anthropicCost } from "@/lib/billing/spend";
import type { Evidence, ExecutionDecisions, Opportunity, RefreshCandidate } from "@/lib/refresh/types";

/**
 * Server actions for the refresh engine.
 *
 * Every one runs through the caller's cookie client, so RLS scopes what it
 * can see to the caller's account, and every write names the workspace it
 * expects the row to belong to. `pushExecutionAction` is the only one that
 * touches a site, and it is the only one that says so.
 */

const IMPROVEMENTS = "/improvements";

/** Run the detectors for one site now. Database only; no model, no spend. */
export async function analyzeNow(workspaceId: string): Promise<AnalyzeResult> {
  await requireAuth();
  const supabase = await createClient();
  const result = await analyzeWorkspace(supabase, workspaceId);
  revalidatePath(IMPROVEMENTS);
  return result;
}

async function ownCandidate(candidateId: string): Promise<RefreshCandidate> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("refresh_candidates")
    .select("*")
    .eq("id", candidateId)
    .maybeSingle();
  if (!data) throw new Error("Candidate not found");
  return data as RefreshCandidate;
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date");

/**
 * Decide to act on a candidate, from a date. The cron runs it on the first
 * enabled weekday on or after that date, one per site per day.
 */
export async function scheduleCandidate(candidateId: string, scheduledFor: string): Promise<string> {
  await requireAuth();
  const date = dateSchema.parse(scheduledFor);
  const candidate = await ownCandidate(candidateId);
  if (candidate.dismissed_at) throw new Error("This candidate was dismissed");
  const supabase = await createClient();

  // One open task per candidate: rescheduling moves it rather than stacking.
  const { data: existing } = await supabase
    .from("refresh_tasks")
    .select("id")
    .eq("candidate_id", candidateId)
    .eq("workspace_id", candidate.workspace_id)
    .in("status", ["scheduled", "failed"])
    .limit(1)
    .maybeSingle();

  let id: string;
  if (existing) {
    const { error } = await supabase
      .from("refresh_tasks")
      .update({ scheduled_for: date, status: "scheduled", error: null })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    id = existing.id as string;
  } else {
    const { data, error } = await supabase
      .from("refresh_tasks")
      .insert({ candidate_id: candidateId, workspace_id: candidate.workspace_id, scheduled_for: date })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Could not schedule");
    id = data.id as string;
  }
  revalidatePath(IMPROVEMENTS);
  return id;
}

export async function cancelTask(taskId: string): Promise<void> {
  await requireAuth();
  const supabase = await createClient();
  const { error } = await supabase
    .from("refresh_tasks")
    .update({ status: "cancelled" })
    .eq("id", taskId)
    .in("status", ["scheduled", "failed"]);
  if (error) throw new Error(error.message);
  revalidatePath(IMPROVEMENTS);
}

/** "Not now." Cancels any pending task with it. */
export async function dismissCandidate(candidateId: string): Promise<void> {
  await requireAuth();
  const candidate = await ownCandidate(candidateId);
  const supabase = await createClient();
  const { error } = await supabase
    .from("refresh_candidates")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", candidateId)
    .eq("workspace_id", candidate.workspace_id);
  if (error) throw new Error(error.message);
  await supabase
    .from("refresh_tasks")
    .update({ status: "cancelled" })
    .eq("candidate_id", candidateId)
    .eq("workspace_id", candidate.workspace_id)
    .eq("status", "scheduled");
  revalidatePath(IMPROVEMENTS);
}

/** A person's edit to the plan. What the rewrite will read. */
export async function saveBrief(candidateId: string, text: string): Promise<void> {
  await requireAuth();
  const candidate = await ownCandidate(candidateId);
  const supabase = await createClient();
  const trimmed = text.trim();
  const { error } = await supabase
    .from("refresh_candidates")
    .update({ brief: trimmed || null, brief_status: trimmed ? "ready" : "pending" })
    .eq("id", candidateId)
    .eq("workspace_id", candidate.workspace_id);
  if (error) throw new Error(error.message);
  revalidatePath(IMPROVEMENTS);
}

/**
 * Write the brief now, from the evidence and the page's headings. One short
 * structured model call; the deterministic plan when no key is configured.
 * Overwrites whatever is there, which is what a "Regenerate" button means.
 */
export async function generateBrief(candidateId: string): Promise<string> {
  await requireAuth();
  const candidate = await ownCandidate(candidateId);
  const supabase = await createClient();

  let headings: string[] = [];
  let title: string | null = null;
  try {
    const body = await loadPageBody(supabase, candidate);
    headings = headingsOf(body.html);
    title = body.title;
  } catch {
    // The page could not be read; the brief still works from the evidence.
  }

  try {
    const out = await writeBrief({
      url: candidate.url,
      title,
      opportunity: candidate.opportunity as Opportunity,
      evidence: candidate.evidence as Evidence,
      headings,
      wordCount: (candidate.evidence as Evidence).word_count,
    });
    if (out.model && out.inputTokens !== undefined) {
      await recordSpend(supabase, {
        provider: "anthropic",
        operation: out.model,
        costUsd: anthropicCost(out.model, out.inputTokens, out.outputTokens ?? 0),
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens ?? null,
        workspaceId: candidate.workspace_id,
        articleId: candidate.article_id,
      });
    }
    const { error } = await supabase
      .from("refresh_candidates")
      .update({ brief: out.text, brief_status: "ready" })
      .eq("id", candidateId)
      .eq("workspace_id", candidate.workspace_id);
    if (error) throw new Error(error.message);
    revalidatePath(IMPROVEMENTS);
    return out.text;
  } catch (err) {
    await supabase
      .from("refresh_candidates")
      .update({ brief_status: "failed" })
      .eq("id", candidateId)
      .eq("workspace_id", candidate.workspace_id);
    throw err;
  }
}

const decisionSchema = z.object({
  decisions: z.record(z.string(), z.enum(["accepted", "rejected"])),
  edited: z.record(z.string(), z.string().max(200_000)),
  fields: z.object({
    title: z.enum(["accepted", "rejected"]).optional(),
    metaDescription: z.enum(["accepted", "rejected"]).optional(),
  }),
});

/** The reviewer's per-hunk decisions. Saved as they go; nothing is pushed. */
export async function saveExecutionDecisions(executionId: string, decisions: ExecutionDecisions): Promise<void> {
  await requireAuth();
  const parsed = decisionSchema.parse(decisions);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("refresh_executions")
    .update({ decisions: parsed })
    .eq("id", executionId)
    .eq("review_status", "awaiting_review")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("This rewrite is no longer awaiting review");
}

export async function rejectExecution(executionId: string): Promise<void> {
  await requireAuth();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("refresh_executions")
    .update({ review_status: "rejected" })
    .eq("id", executionId)
    .eq("review_status", "awaiting_review")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("This rewrite is no longer awaiting review");
  revalidatePath(IMPROVEMENTS);
  revalidatePath(`${IMPROVEMENTS}/${executionId}`);
}

/**
 * THE write to the site. Applies the saved decisions and updates the post in
 * place through the connected adapter. Refuses when nothing was kept, when
 * the page was not published through here, or when the adapter cannot edit.
 */
export async function pushExecutionAction(executionId: string, decisions?: ExecutionDecisions): Promise<PushResult> {
  await requireAuth();
  const supabase = await createClient();
  // Save what is on screen first, so the push applies exactly what the
  // reviewer is looking at and not a debounce behind it.
  if (decisions) await saveExecutionDecisions(executionId, decisions);
  const result = await pushExecution(supabase, executionId);
  revalidatePath(IMPROVEMENTS);
  revalidatePath(`${IMPROVEMENTS}/${executionId}`);
  revalidatePath("/articles");
  return result;
}

/** The reviewed body as HTML and Markdown, for sites the push cannot reach. */
export async function exportExecutionAction(
  executionId: string,
  decisions?: ExecutionDecisions,
): Promise<{ title: string; html: string; markdown: string; url: string }> {
  await requireAuth();
  const supabase = await createClient();
  if (decisions) await saveExecutionDecisions(executionId, decisions);
  return exportExecution(supabase, executionId);
}

const settingsSchema = z.object({
  enabled: z.boolean(),
  days: z.array(z.number().int().min(0).max(6)).max(2, "Pick at most two days"),
});

/** The per-site switch and weekdays. */
export async function setRefreshSettings(
  workspaceId: string,
  settings: { enabled: boolean; days: number[] },
): Promise<void> {
  const { agencyId } = await requireAuth();
  const parsed = settingsSchema.parse(settings);
  const supabase = await createClient();
  const { error } = await supabase
    .from("workspaces")
    .update({ refresh_enabled: parsed.enabled, refresh_days: [...new Set(parsed.days)].sort() })
    .eq("id", workspaceId)
    // Defence in depth over RLS: the id arrives from the browser.
    .eq("agency_id", agencyId);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/refresh");
  revalidatePath(IMPROVEMENTS);
}
