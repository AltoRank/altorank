// ---------------------------------------------------------------------------
// What the URL Inspection API said, kept as it said it
// ---------------------------------------------------------------------------
//
// The Search Console URL Inspection endpoint answers one question per call:
// is this exact URL in Google's index, and if not, why not. The answer is
// stored on `articles.indexing_status.inspection`, beside the IndexNow and
// sitemap results that already live in that jsonb, with the time it was
// asked. Nothing here infers; the coverage state is Google's own sentence.
//
// Scope: the endpoint accepts `webmasters.readonly`, which is the scope
// lib/google/oauth.ts already requests, so an existing connection can
// inspect without reconsenting (verified against the API reference,
// 2026-09-04).

export type UrlInspection = {
  /** PASS | NEUTRAL | FAIL | PARTIAL | VERDICT_UNSPECIFIED, or whatever Google adds next. */
  verdict: string | null;
  /** Google's own sentence: "Submitted and indexed", "Crawled - currently not indexed", ... */
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  lastCrawlTime: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  crawledAs: string | null;
  /** Deep link into Search Console for this URL. */
  inspectionLink: string | null;
  /** When we asked. */
  checkedAt: string;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Parse the response body of urlInspection.index:inspect. Missing fields stay null. */
export function parseInspection(body: unknown, checkedAt: string): UrlInspection {
  const result = (body as { inspectionResult?: Record<string, unknown> } | null)?.inspectionResult ?? {};
  const index = (result.indexStatusResult as Record<string, unknown> | undefined) ?? {};
  return {
    verdict: str(index.verdict),
    coverageState: str(index.coverageState),
    indexingState: str(index.indexingState),
    robotsTxtState: str(index.robotsTxtState),
    pageFetchState: str(index.pageFetchState),
    lastCrawlTime: str(index.lastCrawlTime),
    googleCanonical: str(index.googleCanonical),
    userCanonical: str(index.userCanonical),
    crawledAs: str(index.crawledAs),
    inspectionLink: str(result.inspectionResultLink),
    checkedAt,
  };
}

/** The `inspection` member of `articles.indexing_status`, when one was stored. */
export function inspectionFrom(indexingStatus: unknown): UrlInspection | null {
  const i = (indexingStatus as { inspection?: unknown } | null)?.inspection;
  if (!i || typeof i !== "object") return null;
  const cand = i as Partial<UrlInspection>;
  if (typeof cand.checkedAt !== "string") return null;
  return { ...parseInspection({ inspectionResult: { indexStatusResult: cand } }, cand.checkedAt), inspectionLink: cand.inspectionLink ?? null };
}
