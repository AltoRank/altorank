import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { crawlSite } from "@/lib/audit/crawler";
import { runAuditChecks, calculateAuditScore } from "@/lib/audit/checks";
import { fetchPageSpeed } from "@/lib/audit/pagespeed";

/**
 * POST /api/audit — long-running crawl endpoint.
 * Called internally by startDomainAudit action.
 */
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

  try {
    const baseUrl = workspace.domain.startsWith("http")
      ? workspace.domain
      : `https://${workspace.domain}`;

    // Crawl the site
    const pages = await crawlSite(baseUrl, 100, 3, 500);

    // Run SEO checks
    const issues = runAuditChecks(pages);
    const score = calculateAuditScore(issues, pages.length);

    // Fetch PageSpeed for the homepage
    const pagespeed = await fetchPageSpeed(baseUrl) ?? {};

    // Update audit record
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

    return NextResponse.json({
      success: true,
      pagesCrawled: pages.length,
      issues: issues.length,
      score,
    });
  } catch (err) {
    await supabase
      .from("domain_audits")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", auditId);

    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Crawl failed" },
      { status: 500 },
    );
  }
}
