import { NextResponse } from "next/server";
import { setSpendReporter } from "@/lib/seo/client";
import { recordSpend } from "@/lib/billing/spend";
import { createServiceClient } from "@/lib/supabase/server";
import { analyseDomain } from "@/lib/audit/domain-analysis";

/**
 * First-look analysis for domains nobody has looked at yet.
 *
 *   GET /api/cron/analyze    header: x-cron-secret
 *
 * Adding a client produced an empty workspace: zero keywords, no audit, no
 * readiness score, and a dashboard full of dashes until somebody went and
 * clicked two different buttons. Every one of those analyses reads only public
 * information, so there was never a reason to wait for the client to connect
 * anything first.
 *
 * A cron rather than a fire-and-forget call at workspace creation. Serverless
 * kills a request's background work as soon as the response is sent, so
 * anything started there dies partway through a crawl. Picking the work up from
 * the database makes it restartable and survives a deploy mid-analysis.
 *
 * `first_analysed_at` is set even when layers fail, so a domain that cannot be
 * reached is not retried forever. Re-running is a manual action.
 */

export const maxDuration = 300;

/** Bounded per invocation: each analysis crawls a site and calls two APIs. */
const BATCH = 3;

export async function GET(request: Request) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    setSpendReporter(null);

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { data: pending, error } = await supabase
    .from("workspaces")
    .select("id, domain, language")
    .is("first_analysed_at", null)
    .not("domain", "is", null)
    .neq("status", "paused")
    .order("created_at", { ascending: true })
    .limit(BATCH);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Array<Record<string, unknown>> = [];

  for (const ws of pending ?? []) {
    const workspaceId = ws.id as string;
    const domain = ws.domain as string;

    setSpendReporter(({ operation, costUsd }) => {
      void recordSpend(supabase, {
        provider: "dataforseo",
        operation,
        costUsd,
        workspaceId,
      });
    });

    try {
      const analysis = await analyseDomain({
        domain,
        supabase,
        workspaceId,
        locale: (ws.language as string) ?? "en",
      });

      results.push({
        workspaceId,
        domain,
        status: "analysed",
        headline: analysis.headline,
        readinessScore: analysis.readiness?.score ?? null,
        pagesCrawled: analysis.pagesCrawled,
        keywordsFound: analysis.keywordsFound,
        layers: analysis.layers,
      });
    } catch (err) {
      // analyseDomain is written not to throw, so reaching here means something
      // outside the layers broke. Stamp the workspace anyway rather than
      // re-crawling a broken domain on every run.
      await supabase
        .from("workspaces")
        .update({ first_analysed_at: new Date().toISOString() })
        .eq("id", workspaceId);

      results.push({
        workspaceId,
        domain,
        status: "error",
        detail: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return NextResponse.json({
    pending: pending?.length ?? 0,
    analysed: results.filter((r) => r.status === "analysed").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  });
}
