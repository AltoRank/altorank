import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { setSpendReporter } from "@/lib/seo/client";
import { recordSpend } from "@/lib/billing/spend";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRankings } from "@/lib/seo/serp";
import type { Workspace, Keyword } from "@/lib/types";
import { buildRankingRows } from "@/lib/seo/rankings";

export async function GET(request: Request) {
  // Verify cron secret
  const cronSecret = cronSecretFrom(request);

  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    setSpendReporter(null);

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
 * Cron requests carry no cookies, so the cookie-bound client authenticates as
 * nobody and RLS answers every query with an empty set. That is not an error,
 * so this route reported `success` with a zero count and had never processed a
 * single row. A cron has no user by definition: it must hold the service role.
 */
  const supabase = createServiceClient();

  // Fetch all workspaces
  const { data: workspacesData, error: wsError } = await supabase
    .from("workspaces")
    .select("*");

  if (wsError) {
    return NextResponse.json(
      { error: `Failed to fetch workspaces: ${wsError.message}` },
      { status: 500 },
    );
  }

  const workspaces = (workspacesData ?? []) as Workspace[];
  const results: Array<{
    workspaceId: string;
    domain: string;
    checked: number;
    error?: string;
  }> = [];

  for (const ws of workspaces) {
    if (!ws.domain) {
      results.push({
        workspaceId: ws.id,
        domain: "",
        checked: 0,
        error: "No domain configured",
      });
      continue;
    }

    setSpendReporter(({ operation, costUsd }) => {
      void recordSpend(supabase, {
        provider: "dataforseo",
        operation,
        costUsd,
        workspaceId: ws.id,
      });
    });

    try {
      /**
       * Track what someone chose, not everything discovery ever found.
       *
       * This selected every keyword in the workspace, and discovery writes a
       * thousand rows per domain. A thousand daily SERP checks is roughly
       * $2-3/day - $60-90 a month against a €69 plan, spent mostly on terms
       * nobody is targeting. Planned and shipped are the terms a person
       * picked; the article keywords are the ones the product wrote for.
       * The cap is a backstop, newest first, and is logged when it bites.
       */
      const { data: articleKw } = await supabase
        .from("articles")
        .select("keyword")
        .eq("workspace_id", ws.id);
      const articleTerms = new Set(
        (articleKw ?? []).map((a) => (a.keyword as string).toLowerCase()),
      );

      const TRACK_CAP = 200;
      const { data: kwData, error: kwError } = await supabase
        .from("keywords")
        .select("*")
        .eq("workspace_id", ws.id)
        .in("status", ["planned", "shipped"])
        .order("created_at", { ascending: false })
        .limit(TRACK_CAP);

      if (kwError) {
        results.push({
          workspaceId: ws.id,
          domain: ws.domain,
          checked: 0,
          error: kwError.message,
        });
        continue;
      }

      // Article keywords that never got a keyword row still deserve tracking:
      // the product wrote a page for them.
      let keywords = (kwData ?? []) as Keyword[];
      const known = new Set(keywords.map((k) => k.term.toLowerCase()));
      if (keywords.length < TRACK_CAP && articleTerms.size > 0) {
        const missing = [...articleTerms].filter((t) => !known.has(t));
        if (missing.length > 0) {
          const { data: extra } = await supabase
            .from("keywords")
            .select("*")
            .eq("workspace_id", ws.id)
            .in("term", missing)
            .limit(TRACK_CAP - keywords.length);
          keywords = keywords.concat((extra ?? []) as Keyword[]);
        }
      }
      if (keywords.length === TRACK_CAP) {
        console.warn(`[serp] workspace ${ws.domain}: tracking capped at ${TRACK_CAP} keywords`);
      }
      if (keywords.length === 0) {
        results.push({
          workspaceId: ws.id,
          domain: ws.domain,
          checked: 0,
        });
        continue;
      }

      const terms = keywords.map((k) => k.term);
      const rankings = await checkRankings(terms, ws.domain, {
        languageCode: (ws as { language?: string }).language ?? "en",
        locationCode: (ws as { location_code?: number }).location_code ?? 2840,
      });

      // Build term -> keyword id map
      const termToId = new Map(keywords.map((k) => [k.term, k.id]));

      const rankingRows = buildRankingRows(rankings, termToId);

      /**
       * The Articles page has always had a POSITION column, and articles have
       * always had a `position` column, and nothing ever wrote it: every
       * article showed a dash for as long as it lived. The ranking that just
       * came back for an article's own keyword is that number.
       */
      for (const r of rankings) {
        if (!articleTerms.has(r.keyword.toLowerCase())) continue;
        await supabase
          .from("articles")
          .update({ position: r.position ?? null })
          .eq("workspace_id", ws.id)
          .eq("keyword", r.keyword);
      }

      if (rankingRows.length > 0) {
        const { error: insertError } = await supabase
          .from("keyword_rankings")
          .insert(rankingRows);

        if (insertError) {
          results.push({
            workspaceId: ws.id,
            domain: ws.domain,
            checked: 0,
            error: insertError.message,
          });
          continue;
        }
      }

      results.push({
        workspaceId: ws.id,
        domain: ws.domain,
        checked: rankingRows.length,
      });
    } catch (err) {
      results.push({
        workspaceId: ws.id,
        domain: ws.domain,
        checked: 0,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const totalChecked = results.reduce((sum, r) => sum + r.checked, 0);
  const errors = results.filter((r) => r.error).length;

  return NextResponse.json({
    success: true,
    workspaces: results.length,
    totalChecked,
    errors,
    results,
  });
}
