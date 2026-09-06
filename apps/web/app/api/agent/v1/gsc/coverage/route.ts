import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { gscRows, gscScope, syncBlock } from "@/lib/agent/gsc";
import { coverageBucket, indexCoverage, normalizeUrl, servedUrls, type CoverageBucket } from "@/lib/gsc/analysis";
import { knownPagesFrom } from "@/lib/gsc/queries";

const BUCKETS: CoverageBucket[] = ["indexed", "not_indexed", "unknown"];

/**
 * GET /api/agent/v1/gsc/coverage?workspace_id=&days=&bucket=
 *
 * The dashboard's index-coverage block as data: every page we know the site
 * has (live articles with a URL, pages the sitemap crawl found), bucketed
 * indexed / not_indexed / unknown from stored URL Inspection verdicts and
 * from being served in search over the window. Same arithmetic as the
 * dashboard (lib/gsc/analysis.ts indexCoverage), same page list
 * (lib/gsc/queries.ts knownPagesFrom). "unknown" is a real bucket: a page
 * nobody has measured, not a page that is missing from the index. Nothing
 * here calls Google.
 */
export const GET = withAgent(async (request, ctx) => {
  const q = request.nextUrl.searchParams;
  const bucketParam = q.get("bucket")?.trim() || null;
  if (bucketParam && !BUCKETS.includes(bucketParam as CoverageBucket)) {
    return fail("invalid_request", `bucket must be one of ${BUCKETS.join(", ")}.`, "Omit ?bucket= to get every page with its bucket.");
  }

  const resolved = await gscScope(ctx, q.get("workspace_id"), q.get("days"));
  if ("envelope" in resolved) return resolved.envelope;
  const { scope } = resolved;

  const [rows, known] = await Promise.all([gscRows(ctx, scope), knownPagesFrom(ctx.supabase, scope.workspace.id)]);
  const served = servedUrls(rows, scope.today, scope.days);
  const summary = indexCoverage(known, served);
  const base = appBaseUrl(request);

  const seen = new Set<string>();
  const pages = known
    .filter((p) => {
      const key = normalizeUrl(p.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((p) => {
      const inSearch = served.has(normalizeUrl(p.url));
      return {
        url: p.url,
        title: p.title,
        bucket: coverageBucket(p.inspection, inSearch),
        served_in_search: inSearch,
        inspected_at: p.inspection?.checkedAt ?? null,
        coverage_state: p.inspection?.coverageState ?? null,
        article: p.articleId ? { id: p.articleId, editor_url: `${base}/content/${p.articleId}` } : null,
      };
    })
    .filter((p) => !bucketParam || p.bucket === bucketParam);

  const data = {
    workspace_id: scope.workspace.id,
    days: scope.days,
    sync: syncBlock(scope.health),
    summary: {
      total: summary.total,
      indexed: summary.indexed,
      not_indexed: summary.notIndexed,
      unknown: summary.unknown,
      by_inspection: summary.byInspection,
      by_search: summary.bySearch,
    },
    bucket: bucketParam,
    pages,
  };

  if (summary.total === 0) {
    return ok(
      data,
      "No pages are known for this site yet: no live article has a URL and the sitemap crawl has not run. Nothing here says anything about the index.",
    );
  }
  return ok(
    data,
    `${summary.indexed} of ${summary.total} known pages are indexed, ${summary.notIndexed} not indexed, ${summary.unknown} unmeasured. ` +
      `"unknown" means no URL Inspection is stored and Google did not serve the page in the last ${scope.days} days; it is not "not indexed". ` +
      `Only a human can run URL Inspection (the 'Check indexing' button at each article's editor_url); you cannot trigger it from here.`,
  );
});
