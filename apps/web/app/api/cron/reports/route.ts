import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { generateReport } from "@/lib/reports/generate";
import { sendReportEmail } from "@/lib/email/resend";

/**
 * Monthly cron (1st of month): auto-generate reports for all workspaces.
 */
export async function GET(request: Request) {
  const cronSecret = cronSecretFrom(request);
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
 * Cron requests carry no cookies, so the cookie-bound client authenticates as
 * nobody and RLS answers every query with an empty set. That is not an error,
 * so this route reported `success` with a zero count and had never processed a
 * single row. A cron has no user by definition: it must hold the service role.
 */
  const supabase = createServiceClient();

  // Calculate last month's date range
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    .toISOString()
    .split("T")[0];
  const endDate = new Date(now.getFullYear(), now.getMonth(), 0)
    .toISOString()
    .split("T")[0];

  // Fetch all workspaces with their agency info
  const { data: workspaces, error: workspacesError } = await supabase
    .from("workspaces")
    .select("id, name, agency_id");

  // `generated: 0` must mean there was nothing to generate, not that the
  // workspace list could not be read.
  if (workspacesError) {
    return NextResponse.json({ error: workspacesError.message }, { status: 500 });
  }

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
    /** Why delivery did not happen. Non-fatal, but never silent. */
    emailError?: string;
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
      let emailError: string | undefined;
      try {
        if (!agencyCache.has(ws.agency_id)) {
          const { data: agency, error: agencyError } = await supabase
            .from("agencies")
            .select("name, report_email")
            .eq("id", ws.agency_id)
            .single();
          // Without this the catch below reads a failed lookup as "this agency
          // set no report email" and silently skips delivery forever.
          if (agencyError) throw new Error(`agency lookup: ${agencyError.message}`);
          agencyCache.set(ws.agency_id, {
            name: agency?.name ?? "Your workspace",
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
      } catch (err) {
        // Email delivery failure is non-fatal: the report itself was generated
        // and is retrievable. It is still reported, so a mail outage does not
        // read as a month in which nobody had an address configured.
        emailError = err instanceof Error ? err.message : "Unknown error";
      }

      results.push({ workspaceId: ws.id, name: ws.name, reportId, emailed, emailError });
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
    emailErrors: results.filter((r) => r.emailError).length,
    errors: results.filter((r) => r.error).length,
    results,
  });
}
