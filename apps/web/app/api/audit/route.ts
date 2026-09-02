import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { crawlSite, usablePages } from "@/lib/audit/crawler";
import { runAuditChecks, calculateAuditScore } from "@/lib/audit/checks";
import { fetchPageSpeed } from "@/lib/audit/pagespeed";

/**
 * POST /api/audit — the crawl worker behind startDomainAudit.
 *
 * Three things were wrong here and each one on its own stopped an audit
 * completing, so no audit has ever finished through this path.
 *
 * 1. The caller sent no cookies. This route authenticates with
 *    supabase.auth.getUser(), and startDomainAudit reached it with a bare
 *    fetch(), so every call arrived anonymous and answered 401. `fetch` does
 *    not throw on 4xx, so the caller's `.catch()` never fired and the audit row
 *    sat at "running" for ever. The caller now forwards the session cookie and
 *    checks the status.
 *
 * 2. No maxDuration. Vercel's default is 10 seconds; the work below needs far
 *    more. Declared at 60, which is the Hobby ceiling. (Note the crons here
 *    declare 300, which Hobby silently clamps to 60 — same trap.)
 *
 * 3. The crawl asked for 100 pages at 500ms, which is a 50-second floor before
 *    PageSpeed runs at all, so even with a raised limit it could not fit. The
 *    budget is now stated in terms of the limit rather than picked by feel.
 */
export const maxDuration = 60;

// Must fit inside maxDuration with room for PageSpeed and the DB writes.
// 40 x 400ms = 16s of crawl, leaving ~40s of headroom. These match the bounds
// in lib/audit/domain-analysis.ts deliberately: two callers of one crawl should
// not disagree about how deep it goes.
const MAX_PAGES = 40;
const MAX_DEPTH = 2;
const CRAWL_DELAY_MS = 400;
export async function POST(request: NextRequest) {
  const supabase = await createClient();

  // Auth: verify user is logged in and belongs to an agency
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: member } = await supabase
    .from("agency_members")
    .select("agency_id")
    .eq("user_id", user.id)
    .single();

  if (!member) {
    return NextResponse.json({ error: "No agency membership" }, { status: 403 });
  }

  let body: { auditId: string; workspaceId: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { auditId, workspaceId } = body;

  // Verify workspace belongs to the user's agency
  const { data: wsCheck } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("agency_id", member.agency_id)
    .single();

  if (!wsCheck) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 403 });
  }

  // Fetch workspace domain
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("domain")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.domain) {
    await supabase
      .from("domain_audits")
      .update({ status: "failed", completed_at: new Date().toISOString() })
      .eq("id", auditId);
    return NextResponse.json({ error: "No domain" }, { status: 400 });
  }

  const baseUrl = workspace.domain.startsWith("http")
    ? workspace.domain
    : `https://${workspace.domain}`;

  // Answer now, crawl afterwards. `after` runs once the response is sent and
  // is bounded by the maxDuration above, so the caller is not holding a
  // connection open for a minute waiting on someone else's website.
  //
  // Every exit from here writes a terminal status. The old code could leave a
  // row at "running" for ever, and a status nobody ever clears is worse than a
  // failure: the UI cannot tell "still working" from "died in 2026".
  after(async () => {
    try {
      const fetched = await crawlSite(baseUrl, MAX_PAGES, MAX_DEPTH, CRAWL_DELAY_MS);
      const pages = usablePages(fetched);
      if (!pages.length) {
        // Nothing answered. A failed fetch is not a clean page: the first
        // version scored www.lully.ai 95/100 on a TLS error. Record the reason
        // as the audit's one issue so the UI can show it, and mark it failed.
        const why = fetched.find((p) => p.error)?.error ?? `HTTP ${fetched[0]?.status ?? "?"}`;
        await supabase
          .from("domain_audits")
          .update({
            status: "failed",
            pages_crawled: 0,
            overall_score: null,
            issues: [{ type: "fetch_failed", severity: "high", page: baseUrl, message: `The site could not be fetched: ${why}` }],
            completed_at: new Date().toISOString(),
          })
          .eq("id", auditId);
        return;
      }
      const issues = runAuditChecks(pages);
      const score = calculateAuditScore(issues, pages.length);
      const pagespeed = (await fetchPageSpeed(baseUrl)) ?? {};

      await supabase
        .from("domain_audits")
        .update({
          status: "completed",
          pages_crawled: pages.length,
          overall_score: score,
          issues,
          pagespeed,
          completed_at: new Date().toISOString(),
        })
        .eq("id", auditId);
    } catch (err) {
      // domain_audits has no column for the reason, so it goes to the log and
      // the row just says "failed". Worth a column later; not worth a migration
      // in the commit that makes audits run at all.
      console.error(`[audit ${auditId}] failed:`, err);
      await supabase
        .from("domain_audits")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", auditId);
    }
  });

  // 202: accepted and running. The client polls getAuditStatus.
  return NextResponse.json({ accepted: true, auditId }, { status: 202 });
}
