import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { publishArticleCore } from "@/lib/publishing/core";
import { isCadenceDue, cadenceLocalDate } from "@/lib/publishing/cadence";
import type { PublishingCadence } from "@/lib/types";

export const maxDuration = 60;

type Result = {
  articleId: string;
  workspaceId: string;
  status: "success" | "error";
  error?: string;
};

export async function GET(request: Request) {
  const cronSecret = cronSecretFrom(request);
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const now = new Date();
  const results: Result[] = [];

  // ── Phase 1: per-article overrides (scheduled_at <= now) ──
  const { data: overrideArticles, error: overrideError } = await supabase
    .from("articles")
    .select("id, workspace_id")
    .eq("status", "scheduled")
    .not("scheduled_at", "is", null)
    .lte("scheduled_at", now.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(20);

  // Publishing is the one cron whose "nothing to do" is indistinguishable from
  // "the queue could not be read", and the cost of getting that wrong is a
  // scheduled article that silently never ships.
  if (overrideError) {
    return NextResponse.json({ error: overrideError.message }, { status: 500 });
  }

  for (const article of overrideArticles ?? []) {
    try {
      await publishArticleCore(supabase, article.id);
      await supabase.from("publish_log").insert({
        article_id: article.id,
        workspace_id: article.workspace_id,
        status: "success",
        triggered_by: "cron",
      });
      results.push({
        articleId: article.id,
        workspaceId: article.workspace_id,
        status: "success",
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      await supabase
        .from("articles")
        .update({ status: "error", updated_at: now.toISOString() })
        .eq("id", article.id);
      await supabase.from("publish_log").insert({
        article_id: article.id,
        workspace_id: article.workspace_id,
        status: "error",
        error: errorMsg,
        triggered_by: "cron",
      });
      results.push({
        articleId: article.id,
        workspaceId: article.workspace_id,
        status: "error",
        error: errorMsg,
      });
    }
  }

  // ── Phase 2: workspace cadence (scheduled_at IS NULL) ──
  const { data: cadences, error: cadenceError } = await supabase
    .from("publishing_cadences")
    .select("*")
    .eq("enabled", true);

  if (cadenceError) {
    return NextResponse.json({ error: cadenceError.message }, { status: 500 });
  }

  for (const cadence of (cadences ?? []) as PublishingCadence[]) {
    // "Already published today" is what keeps this idempotent now that the
    // window is gone. Without it a cron running more than once a day would
    // publish the whole queue in a single day. publish_log already records
    // every cron publish, so the check costs one indexed lookup per cadence.
    const { data: lastPublish } = await supabase
      .from("publish_log")
      .select("created_at")
      .eq("workspace_id", cadence.workspace_id)
      .eq("status", "success")
      .order("created_at", { ascending: false })
      .limit(1);

    const lastLocalDate = lastPublish?.[0]?.created_at
      ? cadenceLocalDate(cadence.timezone, new Date(lastPublish[0].created_at))
      : null;

    if (!isCadenceDue(cadence, now, lastLocalDate)) continue;

    // Find oldest scheduled article without a specific scheduled_at
    const { data: queueArticles, error: queueError } = await supabase
      .from("articles")
      .select("id, workspace_id")
      .eq("workspace_id", cadence.workspace_id)
      .eq("status", "scheduled")
      .is("scheduled_at", null)
      .order("created_at", { ascending: true })
      .limit(1);

    // One workspace's unreadable queue should not abort the other workspaces'
    // slots, but it must not read as an empty queue either.
    if (queueError) {
      results.push({
        articleId: "",
        workspaceId: cadence.workspace_id,
        status: "error",
        error: `queue lookup: ${queueError.message}`,
      });
      continue;
    }

    const article = queueArticles?.[0];
    if (!article) continue;

    try {
      await publishArticleCore(supabase, article.id);
      await supabase.from("publish_log").insert({
        article_id: article.id,
        workspace_id: article.workspace_id,
        status: "success",
        triggered_by: "cron",
      });
      results.push({
        articleId: article.id,
        workspaceId: article.workspace_id,
        status: "success",
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      await supabase
        .from("articles")
        .update({ status: "error", updated_at: now.toISOString() })
        .eq("id", article.id);
      await supabase.from("publish_log").insert({
        article_id: article.id,
        workspace_id: article.workspace_id,
        status: "error",
        error: errorMsg,
        triggered_by: "cron",
      });
      results.push({
        articleId: article.id,
        workspaceId: article.workspace_id,
        status: "error",
        error: errorMsg,
      });
    }
  }

  const published = results.filter((r) => r.status === "success").length;
  const errors = results.filter((r) => r.status === "error").length;

  return NextResponse.json({
    success: true,
    published,
    errors,
    results,
  });
}
