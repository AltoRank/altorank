import { withAgent } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { workspaceInAccount } from "@/lib/agent/data";
import { latestGeoRun, summariseRows } from "@/lib/geo/read";

/**
 * GET /api/agent/v1/geo/visibility?workspace_id=
 *
 * The /geo page as data: the latest weekly sweep of the ChatGPT app, Gemini
 * and Google AI Mode for one site - how often the answers named it (with the
 * 95% range that many answers allows), who they named instead, what they
 * cited, and the same per engine and per question. Stored answers only;
 * nothing is asked of any engine by this call.
 */
export const GET = withAgent(async (request, ctx) => {
  const workspaceId = request.nextUrl.searchParams.get("workspace_id");
  if (!workspaceId) return fail("invalid_request", "workspace_id is required.", "Pass ?workspace_id= from GET /workspaces.");
  const workspace = await workspaceInAccount(ctx, workspaceId);
  if (!workspace) return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");

  const tracking = Boolean((workspace as { geo_tracking?: boolean }).geo_tracking);
  const latest = await latestGeoRun(ctx.supabase, workspace.id);
  if (!latest) {
    return ok(
      { workspace_id: workspace.id, tracking, run: null },
      tracking
        ? "Tracking is on but no sweep has started yet: one starts at the next daily 08:00 run if the site has questions. This is no data, not zero visibility."
        : "AI visibility is not tracked for this site. Switch it on with POST /geo/tracking and add questions with POST /geo/prompts. Do not report a mention rate.",
    );
  }

  const { run, rows } = latest;
  const answered = rows.filter((r) => r.status === "ok");
  const summary = summariseRows(rows);
  const tally = (key: (r: (typeof answered)[number]) => string) => {
    const m = new Map<string, { answers: number; mentioned: number; cited: number }>();
    for (const r of answered) {
      const e = m.get(key(r)) ?? { answers: 0, mentioned: 0, cited: 0 };
      e.answers += 1;
      if (r.mentioned) e.mentioned += 1;
      if (r.cited) e.cited += 1;
      m.set(key(r), e);
    }
    return [...m.entries()].map(([name, e]) => ({ name, ...e }));
  };

  const data = {
    workspace_id: workspace.id,
    tracking,
    run: {
      id: run.id,
      status: run.status,
      planned: run.planned,
      captured: run.captured,
      failed: run.failed,
      started_at: run.started_at,
      finished_at: run.finished_at,
      cost_usd: run.cost_usd,
      surfaces: run.settings?.surfaces ?? [],
      samples_per_question: run.settings?.samples ?? null,
    },
    answers: summary.probesRun,
    mention_rate_pct: summary.probesRun ? summary.mentionRate : null,
    mention_range_95_pct: summary.probesRun ? summary.mentionInterval : null,
    citation_rate_pct: summary.probesRun ? summary.citationRate : null,
    named_instead: summary.topBrands,
    cited_domains: summary.topCompetitors,
    by_engine: tally((r) => r.engine),
    by_question: tally((r) => r.prompt),
  };

  if (!summary.probesRun) {
    return ok(
      data,
      run.status === "running"
        ? `The sweep is still collecting (${run.captured}/${run.planned} answers so far, none readable yet). Say it is in progress; do not report a rate.`
        : "The latest sweep captured no answers, so there is nothing to report: no data, not zero visibility.",
    );
  }
  return ok(
    data,
    `Named in ${summary.mentionRate}% of ${summary.probesRun} answers (95% range ${summary.mentionInterval.low}-${summary.mentionInterval.high}%). ` +
      `Always give the range with the rate: with few answers a small rate cannot be told from zero. ` +
      (run.status === "running" ? `The sweep is still collecting (${run.captured}/${run.planned}); the number will move. ` : run.status === "partial" ? `The sweep closed partial (${run.captured}/${run.planned}): a smaller measurement than planned. ` : "") +
      `named_instead are rival brands; cited_domains are sources the answers read, not necessarily rivals.`,
  );
});
