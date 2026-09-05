import { NextResponse } from "next/server";
import { withAgent } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { listKeywords, plannedDatesFor, workspaceInAgency } from "@/lib/agent/data";
import { keywordsToCsv, type ExportableKeyword } from "@/lib/keywords/export";

const MAX_ROWS = 5000;

/**
 * GET /api/agent/v1/keywords/export?workspace_id=&format=csv|json&status=
 *
 * Every tracked keyword as a file. `json` is the usual envelope with `rows`;
 * `csv` is text/csv with a Content-Disposition, the one response on this API
 * that is not an envelope, because a CSV wrapped in JSON is not a file.
 * Unmeasured numbers are empty cells, never 0.
 */
export const GET = withAgent(async (request, ctx) => {
  const q = request.nextUrl.searchParams;
  const workspaceId = q.get("workspace_id");
  if (!workspaceId) return fail("invalid_request", "workspace_id is required.", "Pass ?workspace_id= from GET /workspaces.");
  const format = (q.get("format") ?? "json").toLowerCase();
  if (format !== "csv" && format !== "json") return fail("invalid_request", `Unknown format "${format}".`, "Use format=csv or format=json.");

  const workspace = await workspaceInAgency(ctx, workspaceId);
  if (!workspace) return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");

  const [keywords, planned] = await Promise.all([
    listKeywords(ctx.supabase, workspace.id, { status: q.get("status") ?? undefined, limit: MAX_ROWS }),
    plannedDatesFor(ctx.supabase, workspace.id),
  ]);
  const rows: ExportableKeyword[] = keywords.map((k) => ({
    id: k.id,
    term: k.term,
    volume: k.volume ?? null,
    difficulty: k.difficulty ?? null,
    cpc: k.cpc ?? null,
    intent: k.intent ?? null,
    status: k.status,
    planned_for: planned.get(k.id) ?? null,
    created_at: k.created_at,
  }));

  if (format === "csv") {
    const filename = `keywords-${(workspace.domain || workspace.id).replace(/[^a-z0-9.-]/gi, "_")}.csv`;
    return new NextResponse(keywordsToCsv(rows), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return ok(
    { workspace_id: workspace.id, format: "json", rows, count: rows.length, truncated: rows.length >= MAX_ROWS },
    rows.length
      ? `${rows.length} keyword${rows.length === 1 ? "" : "s"}. Empty volume/difficulty/cpc means unmeasured, not zero. Add format=csv for a file to hand the human.`
      : "No keywords tracked for this workspace.",
  );
});
