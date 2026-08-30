import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateReport } from "@/lib/reports/generate";
import { sendReportEmail } from "@/lib/email/resend";

/**
 * Monthly cron (1st of month): auto-generate reports for all workspaces.
 */
export async function GET(request: Request) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createClient();

  // Calculate last month's date range
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    .toISOString()
    .split("T")[0];
  const endDate = new Date(now.getFullYear(), now.getMonth(), 0)
    .toISOString()
    .split("T")[0];

  // Fetch all workspaces with their agency info
  const { data: workspaces } = await supabase
    .from("workspaces")
    .select("id, name, agency_id");

  if (!workspaces?.length) {
    return NextResponse.json({ success: true, generated: 0 });
  }

  // Cache agency info to avoid repeated queries
  const agencyCache = new Map<string, { name: string; reportEmail: string | null }>();

  const results: Array<{
    workspaceId: string;
    name: string;
    reportId?: string;
    emailed?: boolean;
    error?: string;
  }> = [];

  for (const ws of workspaces) {
    try {
      const { reportId, url } = await generateReport(
        supabase,
        ws.id,
        startDate,
        endDate,
      );

      // Attempt email delivery
      let emailed = false;
      try {
        if (!agencyCache.has(ws.agency_id)) {
          const { data: agency } = await supabase
            .from("agencies")
            .select("name, report_email")
            .eq("id", ws.agency_id)
            .single();
          agencyCache.set(ws.agency_id, {
            name: agency?.name ?? "Your Agency",
            reportEmail: agency?.report_email ?? null,
          });
        }

        const agencyInfo = agencyCache.get(ws.agency_id)!;
        const recipient = agencyInfo.reportEmail;

        if (recipient) {
          // Get quick stats for the email
          const { count: articleCount } = await supabase
            .from("articles")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", ws.id)
            .eq("status", "live")
            .gte("published_at", startDate)
            .lte("published_at", endDate);

          const { count: keywordCount } = await supabase
            .from("keywords")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", ws.id);

          await sendReportEmail(
            recipient,
            ws.name,
            agencyInfo.name,
            `${startDate} to ${endDate}`,
            url,
            {
              articlesPublished: articleCount ?? 0,
              keywordsTracked: keywordCount ?? 0,
            },
          );
          emailed = true;
        }
      } catch {
        // Email delivery failure is non-fatal
      }

      results.push({ workspaceId: ws.id, name: ws.name, reportId, emailed });
    } catch (err) {
      results.push({
        workspaceId: ws.id,
        name: ws.name,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return NextResponse.json({
    success: true,
    period: `${startDate} to ${endDate}`,
    generated: results.filter((r) => r.reportId).length,
    emailed: results.filter((r) => r.emailed).length,
    errors: results.filter((r) => r.error).length,
    results,
  });
}
