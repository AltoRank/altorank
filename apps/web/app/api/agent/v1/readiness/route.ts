import { withAgent } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { workspaceInAgency } from "@/lib/agent/data";
import { buildReadinessReport } from "@/lib/audit/readiness-report";

// Several fetches against a third-party site; the dashboard gives it the same.
export const maxDuration = 60;

/**
 * GET /api/agent/v1/readiness?workspace_id=   (or ?domain= for any site)
 *
 * The same report the /readiness page and `altorank_readiness_report` MCP
 * tool produce. Nothing is stored.
 */
export const GET = withAgent(async (request, ctx) => {
  const q = request.nextUrl.searchParams;
  let domain = q.get("domain")?.trim() || null;
  const workspaceId = q.get("workspace_id");

  if (workspaceId) {
    const workspace = await workspaceInAgency(ctx, workspaceId);
    if (!workspace) {
      return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");
    }
    if (!workspace.domain) {
      return fail("invalid_request", "This workspace has no domain.", "Ask the human to set the site's domain, or pass ?domain= directly.");
    }
    domain = workspace.domain;
  }
  if (!domain) {
    return fail("invalid_request", "workspace_id or domain is required.", "Pass ?workspace_id= from GET /workspaces, or ?domain=example.com.");
  }

  const report = await buildReadinessReport(domain);
  if (report.error) {
    return fail("upstream_error", `${domain}: ${report.error}`, "The site could not be read. Confirm the domain resolves over https, then retry once.");
  }

  const failing = report.result.findings.filter((f) => !f.passed);
  const high = failing.filter((f) => f.severity === "high").length;
  return ok(
    { workspace_id: workspaceId ?? null, report },
    failing.length
      ? `Score ${report.result.score}/100 with ${failing.length} failing check(s), ${high} high severity. Walk the human through the high ones first; each artifact carries a placement instruction. You cannot change their site from here.`
      : `Score ${report.result.score}/100 with every check passing. Nothing to fix; say so plainly.`,
  );
});
