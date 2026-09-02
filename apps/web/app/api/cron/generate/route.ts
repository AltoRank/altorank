import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { recommendKeywords, pickNextKeyword } from "@/lib/seo/recommendations";
import { profileIsUsable } from "@/lib/seo/topical-profile";
import { generateArticle } from "@/lib/content/generate";

/**
 * Scheduled draft generation.
 *
 *   GET /api/cron/generate    header: x-cron-secret
 *
 * For each workspace that has opted in, picks the highest-scoring keyword from
 * the recommendation queue and writes a draft into `review`.
 *
 * It does not publish, and there is no flag to make it publish. The approval
 * gate is what separates this from a content farm, and the moment a machine can
 * both choose a topic and put it on a client's site unreviewed, the gate is
 * decorative.
 *
 * Three things bound the damage a misconfiguration can do:
 *
 *   opt-in         `workspaces.auto_generate` defaults false, so this spends
 *                  nobody's API budget until they ask
 *   weekly limit   counted from articles actually written, so retries and a
 *                  too-frequent schedule cannot run up a bill
 *   quality filter `pickNextKeyword` refuses provider noise, so an unattended
 *                  run will not write "S Eo: A Complete Guide"
 *
 * Runs one workspace at a time on purpose. Generation is a long model call, and
 * a serverless invocation that fans out across every workspace at once is the
 * one most likely to hit a wall-clock timeout halfway through and leave rows in
 * `drafting`.
 */

export const maxDuration = 300;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface WorkspaceOutcome {
  workspaceId: string;
  domain: string | null;
  status: "generated" | "skipped" | "error";
  detail: string;
  keyword?: string;
  articleId?: string;
}

export async function GET(request: Request) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { data: workspaces, error } = await supabase
    .from("workspaces")
    .select("id, domain, auto_generate_weekly_limit")
    .eq("auto_generate", true)
    .neq("status", "paused");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: WorkspaceOutcome[] = [];
  const since = new Date(Date.now() - WEEK_MS).toISOString();

  for (const ws of workspaces ?? []) {
    const workspaceId = ws.id as string;
    const domain = (ws.domain as string | null) ?? null;
    const limit = (ws.auto_generate_weekly_limit as number) ?? 2;

    try {
      if (limit <= 0) {
        results.push({ workspaceId, domain, status: "skipped", detail: "weekly limit is 0" });
        continue;
      }

      // Count what was actually written, not what was scheduled. A retry that
      // succeeded after a timeout still consumed budget and still produced a
      // draft somebody has to read.
      const { count } = await supabase
        .from("articles")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("generated_autonomously", true)
        .gte("created_at", since);

      if ((count ?? 0) >= limit) {
        results.push({
          workspaceId,
          domain,
          status: "skipped",
          detail: `weekly limit reached (${count}/${limit})`,
        });
        continue;
      }

      // No vocabulary, no unattended article. With nothing to judge relevance
      // against, the queue is the provider's generic head terms, and the first
      // draft on the lully.ai workspace would have been "ai can". A human can
      // still pick a keyword by hand; the cron does not guess.
      const { data: wsProfile } = await supabase
        .from("workspaces")
        .select("topical_profile")
        .eq("id", workspaceId)
        .single();
      if (!profileIsUsable(wsProfile?.topical_profile as never, domain ?? undefined)) {
        results.push({
          workspaceId,
          domain,
          status: "skipped",
          detail: "the site could not be read well enough to judge which keywords are on-topic; check the audit for why, then pick a keyword by hand",
        });
        continue;
      }

      const recommendations = await recommendKeywords(supabase, workspaceId, { limit: 25 });
      const next = pickNextKeyword(recommendations);

      if (!next) {
        results.push({
          workspaceId,
          domain,
          status: "skipped",
          detail: recommendations.length
            ? "no keyword qualifies: all are covered, already ranking, or flagged as provider noise"
            : "no keywords tracked for this workspace",
        });
        continue;
      }

      const result = await generateArticle({
        supabase,
        workspaceId,
        keyword: next.term,
        autonomous: true,
        // Carry the rationale onto the draft. It used to reach the reviewer
        // only as reasons[0] inside an activity-log line, which is the wrong
        // place: the person deciding whether to publish is looking at the
        // article, not the log.
        selection: {
          reasons: next.reasons,
          score: next.score,
          difficulty: next.difficulty,
          volume: next.volume,
        },
      });

      results.push({
        workspaceId,
        domain,
        status: "generated",
        keyword: next.term,
        articleId: result.articleId,
        detail: `${result.wordCount} words, fact check ${result.factCheck.verdict}, chosen because ${next.reasons[0]}`,
      });
    } catch (err) {
      results.push({
        workspaceId,
        domain,
        status: "error",
        detail: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return NextResponse.json({
    checked: workspaces?.length ?? 0,
    generated: results.filter((r) => r.status === "generated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  });
}
