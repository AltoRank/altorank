import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { gscRows, gscScope, syncBlock } from "@/lib/agent/gsc";
import { coverageBucket, normalizeUrl, servedUrls } from "@/lib/gsc/analysis";
import { inspectionFrom } from "@/lib/google/inspection";

/**
 * GET /api/agent/v1/gsc/url-inspection?workspace_id=&url=
 *
 * What Google last said about one of the site's URLs, as stored on the
 * article when a human pressed "Check indexing" in the editor, plus whether
 * the URL was served in search over the window. Nothing here asks Google:
 * the inspection quota is per property per day and is sized for a person
 * clicking on one article, not an agent walking a list.
 */
export const GET = withAgent(async (request, ctx) => {
  const q = request.nextUrl.searchParams;
  const url = q.get("url")?.trim() || null;
  if (!url) return fail("invalid_request", "url is required.", "Pass ?url= with the full https URL of a page on this site (GET /gsc/coverage lists them).");

  const resolved = await gscScope(ctx, q.get("workspace_id"), q.get("days"));
  if ("envelope" in resolved) return resolved.envelope;
  const { scope } = resolved;

  const key = normalizeUrl(url);
  const [rows, { data: articles }] = await Promise.all([
    gscRows(ctx, scope),
    ctx.supabase
      .from("articles")
      .select("id, title, status, published_url, indexing_status")
      .eq("workspace_id", scope.workspace.id)
      .not("published_url", "is", null),
  ]);
  const article = ((articles ?? []) as { id: string; title: string; status: string; published_url: string; indexing_status: unknown }[]).find(
    (a) => normalizeUrl(a.published_url) === key,
  );
  const inspection = article ? inspectionFrom(article.indexing_status) : null;
  const inSearch = servedUrls(rows, scope.today, scope.days).has(key);
  const bucket = coverageBucket(inspection, inSearch);
  const base = appBaseUrl(request);

  const data = {
    workspace_id: scope.workspace.id,
    url,
    sync: syncBlock(scope.health),
    article: article ? { id: article.id, title: article.title, status: article.status, editor_url: `${base}/content/${article.id}` } : null,
    served_in_search: inSearch,
    bucket,
    inspection,
  };

  if (!article) {
    return ok(
      data,
      inSearch
        ? "This URL is not one of AltoRank's articles, but Google served it in search during the window, so it is indexed. No inspection detail is stored for pages we did not write."
        : "This URL is not one of AltoRank's articles and was not served in search during the window. Its index state is unknown; only a human can run URL Inspection in Search Console for it.",
    );
  }
  if (!inspection) {
    return ok(
      data,
      inSearch
        ? "Indexed: Google served this page in search during the window. No URL Inspection has been run; a human can request one with 'Check indexing' at editor_url if they want Google's own verdict."
        : "Unknown: no URL Inspection stored and not served in search during the window. Ask the human to press 'Check indexing' at editor_url; you cannot run the inspection from here.",
    );
  }
  return ok(
    data,
    `Google's verdict on ${inspection.checkedAt.slice(0, 10)}: ${inspection.coverageState ?? inspection.verdict ?? "unspecified"}. ` +
      (bucket === "not_indexed"
        ? "Not in the index. Relay coverage_state verbatim and, if googleCanonical differs from userCanonical, say Google chose another canonical. A fresh inspection is the human's click at editor_url."
        : "Indexed. If the human wants a newer verdict they can press 'Check indexing' at editor_url."),
  );
});
