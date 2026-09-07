import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { generateReport } from "@/lib/reports/generate";
import { reportRecipients } from "@/lib/reports/recipients";
import { sendReportEmail } from "@/lib/email/resend";
import { getQuota, entitledToScheduledWork } from "@/lib/billing/quota";

/**
 * Monthly cron (1st of month): auto-generate reports for all workspaces.
 *
 * Every workspace, one PDF render and one upload each, in a single invocation.
 * When it runs out of time it stops part way through the list with no marker
 * saying where, so the sites at the end of it never get a report at all. The
 * row upserts on (workspace_id, period), so a re-run is safe.
 *
 * The declared 300 matches the other long jobs, but on the Vercel **Hobby**
 * plan this project is on (verified 2026-09-06) the cap is 60s and this value
 * is ignored. It records the requirement; it does not currently grant it.
 */
export const maxDuration = 300;

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
  // Built in UTC: the local-time constructor followed by toISOString() slid
  // both ends back a day on any server east of Greenwich.
  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .split("T")[0];
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
    .toISOString()
    .split("T")[0];

  // Every workspace except the paused ones. This is the one scheduled job a
  // customer sees the output of: a paused client was still being sent a
  // monthly PDF about a month in which nothing was meant to happen.
  const { data: workspaces, error: workspacesError } = await supabase
    .from("workspaces")
    .select("id, name, agency_id")
    .neq("status", "paused");

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
  // The plan gate, once per agency: every site on an account gets the same
  // answer and the quota read is two queries.
  const entitled = new Map<string, boolean>();

  const results: Array<{
    workspaceId: string;
    name: string;
    reportId?: string;
    emailed?: boolean;
    /** Why delivery did not happen. Non-fatal, but never silent. */
    emailError?: string;
    skipped?: string;
    error?: string;
  }> = [];

  for (const ws of workspaces) {
    // A PDF render, an upload and a mail per site, none of it free, and none
    // of it owed to an account that never chose a plan - the same rule serp
    // and geo apply (entitledToScheduledWork). Until 2026-09-07 this was the
    // one cron without it, so a free account with seven drafts and no plan
    // still got a monthly report generated and stored.
    if (!entitled.has(ws.agency_id)) {
      const quota = await getQuota(supabase, ws.agency_id as string, null);
      entitled.set(ws.agency_id, entitledToScheduledWork(quota));
    }
    if (!entitled.get(ws.agency_id)) {
      results.push({ workspaceId: ws.id, name: ws.name, skipped: "no plan" });
      continue;
    }

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
        // The configured address, or - since it is NULL by default and most
        // accounts never set it - the members who can see this site. Before
        // this the report went to nobody and the run said success.
        const recipients = await reportRecipients(supabase, ws.agency_id, ws.id, agencyInfo.reportEmail);

        if (recipients.length) {
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

          for (const recipient of recipients) {
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
          }
          emailed = true;
        } else {
          emailError = "no recipient: report_email is unset and no member can see this workspace";
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
    skipped: results.filter((r) => r.skipped).length,
    errors: results.filter((r) => r.error).length,
    results,
  });
}
