import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRankings } from "@/lib/seo/serp";
import type { Workspace, Keyword } from "@/lib/types";
import { buildRankingRows } from "@/lib/seo/rankings";

export async function GET(request: Request) {
  // Verify cron secret
  const cronSecret = request.headers.get("x-cron-secret");

  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createClient();

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

    try {
      // Fetch keywords for this workspace
      const { data: kwData, error: kwError } = await supabase
        .from("keywords")
        .select("*")
        .eq("workspace_id", ws.id);

      if (kwError) {
        results.push({
          workspaceId: ws.id,
          domain: ws.domain,
          checked: 0,
          error: kwError.message,
        });
        continue;
      }

      const keywords = (kwData ?? []) as Keyword[];
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
