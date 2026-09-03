import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { recommendKeywords, pickNextKeyword } from "@/lib/seo/recommendations";
import { profileIsUsable } from "@/lib/seo/topical-profile";
import { getQuota, quotaExceededMessage } from "@/lib/billing/quota";
import { generateArticle } from "@/lib/content/generate";
import { PAID_DEFAULT_PACE } from "@/lib/content/pace";
import { agencyRecipients } from "@/lib/email/agency-recipients";
import { sendArticleDraftedEmails } from "@/lib/email/article-emails";
import {
  orderByStaleness,
  latestPerWorkspace,
  MAX_ARTICLES_PER_RUN,
} from "@/lib/content/generate-queue";

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
 *
 * That caution had become a price. One article per workspace per run, once a
 * day, capped a site near 30 a month against a plan sold as 100 - and made
 * `auto_generate_weekly_limit` a setting a customer could raise past anything
 * the schedule could deliver, since a daily run can never write more than
 * seven in a week. The ceiling was a five-minute function, not a view about
 * how often a site should publish.
 *
 * So: four runs a day, and an explicit ceiling on how much any one invocation
 * will do. Those go together - a bound per run is what makes running more often
 * safe, and frequent runs are what make the bound cheap, because whatever is
 * left waits six hours rather than a day.
 *
 * The four runs are not all in vercel.json. The Vercel account is on Hobby,
 * which rejects any cron expression firing more than once a day - the
 * deployment fails outright, so `0 1,7,13,19 * * *` here is not an option
 * without a Pro upgrade. Vercel keeps the 07:00 run; .github/workflows/
 * generate-cron.yml calls this same endpoint at 01/13/19 UTC with the same
 * secret. One code path, two schedulers.
 *
 * If that workflow is not armed (its secret is unset), this route still behaves
 * exactly as it did - once a day, bounded. Nothing here depends on the extra
 * runs arriving.
 *
 * Nothing about the safety rails changes: `auto_generate` is still opt-in, the
 * weekly limit still caps each workspace, and the plan quota still caps the
 * account. Spend follows articles written, not runs.
 */

// A literal, and it has to be: route segment config is read statically, so
// `= RUN_BUDGET_SECONDS` fails the build with "Invalid segment configuration
// export detected". Kept in step with that constant, which MAX_ARTICLES_PER_RUN
// is derived from, by a test that reads this line rather than by hoping.
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
  const cronSecret = cronSecretFrom(request);
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { data: workspaces, error } = await supabase
    .from("workspaces")
    .select("id, domain, agency_id, auto_generate_weekly_limit")
    .eq("auto_generate", true)
    .neq("status", "paused");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: WorkspaceOutcome[] = [];
  const since = new Date(Date.now() - WEEK_MS).toISOString();

  // Least-recently-written first, so the cap below rotates rather than serving
  // whoever the database happened to return first on all four daily runs. The
  // window matches the one the weekly limit uses; see lib/content/generate-queue.
  const { data: recent } = await supabase
    .from("articles")
    .select("workspace_id, created_at")
    .eq("generated_autonomously", true)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  const queue = orderByStaleness(workspaces ?? [], latestPerWorkspace(recent ?? []));

  let written = 0;

  for (const ws of queue) {
    if (written >= MAX_ARTICLES_PER_RUN) {
      results.push({
        workspaceId: ws.id as string,
        domain: (ws.domain as string | null) ?? null,
        status: "skipped",
        detail: `run limit reached (${MAX_ARTICLES_PER_RUN}); the next run starts here`,
      });
      continue;
    }

    const workspaceId = ws.id as string;
    const domain = (ws.domain as string | null) ?? null;
    // Falls back to the same number the column now defaults to (042), so a
    // row written before that migration is not quietly held at the old 2.
    const limit = (ws.auto_generate_weekly_limit as number) ?? PAID_DEFAULT_PACE;

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

      // Out of quota is a state, not an error. A no-plan account whose free
      // draft is used would otherwise log an "error" every morning until it
      // paid; the honest word is "skipped", with the reason the queue shows.
      const quota = await getQuota(supabase, ws.agency_id as string, null);
      if (quota.limit !== null && (quota.remaining ?? 0) <= 0) {
        results.push({ workspaceId, domain, status: "skipped", detail: quotaExceededMessage(quota) });
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
        // Explicitly nobody, matching the getQuota call above. Without this the
        // gate inside generateArticle resolves its own answer and can reach a
        // different verdict for the same agency.
        callerEmail: null,
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

      // Counted here, not before the call: a generation that threw consumed
      // time but produced nothing, and the bound is on articles written.
      written += 1;

      // Announce it. A draft nobody is told about is the failure mode this
      // whole schedule creates: four runs a day writing into a queue that only
      // shows itself to someone who opens the dashboard.
      //
      // After the article is saved, and never allowed to fail the run. The
      // work is done and the row exists; an unreachable mail provider must not
      // turn that into an "error" the operator has to investigate, and must not
      // cost the workspace its weekly slot. The outcome is reported instead.
      let notified = "";
      try {
        const to = await agencyRecipients(supabase, ws.agency_id as string);
        const out = await sendArticleDraftedEmails(to, {
          domain,
          keyword: next.term,
          title: result.title,
          wordCount: result.wordCount,
          verdict: result.factCheck.verdict,
          reasons: next.reasons,
          articleId: result.articleId,
        });
        notified = out.failed
          ? `, emailed ${out.sent}/${to.length} (${out.lastError ?? "failed"})`
          : out.sent
            ? `, emailed ${out.sent}`
            : ", nobody to email";
      } catch (err) {
        notified = `, email failed (${err instanceof Error ? err.message : "unknown"})`;
      }

      results.push({
        workspaceId,
        domain,
        status: "generated",
        keyword: next.term,
        articleId: result.articleId,
        detail: `${result.wordCount} words, fact check ${result.factCheck.verdict}, chosen because ${next.reasons[0]}${notified}`,
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
