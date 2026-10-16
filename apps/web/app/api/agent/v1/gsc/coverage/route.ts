import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { gscRows, gscScope, measuredIn, notSyncedGuidance, staleNote, syncBlock } from "@/lib/agent/gsc";
import { coverageBucket, indexCoverage, inspectionSuperseded, normalizeUrl, servedUrls, windows, type CoverageBucket } from "@/lib/gsc/analysis";
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

  const [gsc, known] = await Promise.all([gscRows(ctx, scope), knownPagesFrom(ctx.supabase, scope.workspace.id)]);
  const served = servedUrls(gsc, scope.today, scope.days);
  const summary = indexCoverage(known, served);
  // Whether "not served in search" means anything: with nothing synced for
  // the window, every page is absent from the rows and none of it is Google's.
  const measured = measuredIn(scope, gsc, windows(scope.today, scope.days).current);
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
      const lastServed = served.get(normalizeUrl(p.url)) ?? null;
      const bucket = coverageBucket(p.inspection, lastServed !== null, lastServed);
      return {
        url: p.url,
        title: p.title,
        bucket,
        served_in_search: lastServed !== null,
        last_served_in_search: lastServed,
        // Served in search after a stored "not indexed": the verdict is out of date.
        inspection_superseded:
          bucket === "indexed" && (p.inspection?.verdict === "FAIL" || p.inspection?.verdict === "NEUTRAL") && inspectionSuperseded(p.inspection, lastServed),
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
    has_data: measured,
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
  if (!measured) {
    return ok(
      data,
      notSyncedGuidance(scope.health, scope.now) +
        ` Until it is, the buckets rest on stored URL Inspection verdicts alone (${summary.byInspection} of ${summary.total} pages): "unknown" says nothing about whether Google serves a page, and nothing here says a page is missing from search.`,
    );
  }
  return ok(
    data,
    `${summary.indexed} of ${summary.total} known pages are indexed, ${summary.notIndexed} not indexed, ${summary.unknown} unmeasured. ` +
      `"unknown" means no URL Inspection is stored and Google did not serve the page in the last ${scope.days} days; it is not "not indexed". ` +
      `Only a human can run URL Inspection (the 'Check indexing' button at each article's editor_url); you cannot trigger it from here.` +
      staleNote(scope.health),
  );
});
