// ---------------------------------------------------------------------------
// Tell the engines the page exists, the moment it exists
// ---------------------------------------------------------------------------
//
// Publishing wrote the article to the CMS and then waited for crawlers to
// notice, which for a low-authority domain can take days to weeks - exactly
// the window where "we published for you" is indistinguishable from "we did
// nothing". Two channels close it:
//
//   IndexNow   One POST covers Bing, Yandex, Seznam and Naver. It needs a key
//              the site can prove it owns: a text file at
//              https://{host}/{key}.txt. We generate the key per workspace;
//              hosting the file is one manual step (or one commit on a
//              git-published site).
//
//   Google     Has no public submit-a-URL API (the Indexing API is scoped to
//              job postings, and the sitemap ping endpoint was retired in
//              2023). What works with the Search Console access we may
//              already hold from the analytics integration is re-submitting
//              the sitemap, which prompts a recrawl.
//
// Everything here is best-effort by design: indexing must never fail a
// publish that already succeeded. Results are reported, not thrown.

import { randomBytes } from "node:crypto";

export type IndexingResult = {
  indexnow: "submitted" | "no-key" | "failed" | "awaiting-build";
  google: "sitemap-resubmitted" | "not-connected" | "failed" | "awaiting-build";
  /**
   * Only set for git publishes, where "published" and "live" are two events.
   *
   * Every other adapter's API returns a URL that already resolves, so there is
   * nothing to confirm. A commit only triggers a build, so the URL is a
   * prediction until a deploy has run - and submitting a prediction to IndexNow
   * is how you report a 404 to Bing under a client's domain.
   *
   * pending     - committed, build not yet confirmed
   * confirmed   - the URL resolved, and indexing was submitted at that point
   * unconfirmed - never resolved within the retry budget; see publish cron
   */
  urlVerified?: "pending" | "confirmed" | "unconfirmed";
  /** Verification passes spent so far, so the cron can give up. */
  attempts?: number;
};

/** 32 hex chars, the format IndexNow's docs use. */
export function generateIndexNowKey(): string {
  return randomBytes(16).toString("hex");
}

async function submitIndexNow(host: string, key: string, urls: string[]): Promise<boolean> {
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host,
      key,
      keyLocation: `https://${host}/${key}.txt`,
      urlList: urls,
    }),
  });
  // 200 and 202 both mean accepted. 403 means the key file is not in place,
  // which is a setup problem worth surfacing, not an outage.
  return res.status === 200 || res.status === 202;
}

async function resubmitSitemap(accessToken: string, host: string): Promise<boolean> {
  const site = encodeURIComponent(`sc-domain:${host}`);
  const sitemap = encodeURIComponent(`https://${host}/sitemap.xml`);
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${site}/sitemaps/${sitemap}`,
    { method: "PUT", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return res.ok;
}

/**
 * Submit a freshly published URL everywhere we can.
 *
 * @param opts.indexNowKey  workspace.indexnow_key; skipped when null.
 * @param opts.gscToken     A live Search Console access token, when the
 *                          workspace has the Google integration; skipped when
 *                          null.
 */
export async function submitForIndexing(opts: {
  url: string;
  indexNowKey: string | null;
  gscToken: string | null;
}): Promise<IndexingResult> {
  const result: IndexingResult = { indexnow: "no-key", google: "not-connected" };

  let host: string;
  try {
    host = new URL(opts.url).host;
  } catch {
    return result;
  }

  if (opts.indexNowKey) {
    try {
      result.indexnow = (await submitIndexNow(host, opts.indexNowKey, [opts.url]))
        ? "submitted"
        : "failed";
    } catch {
      result.indexnow = "failed";
    }
  }

  if (opts.gscToken) {
    try {
      result.google = (await resubmitSitemap(opts.gscToken, host))
        ? "sitemap-resubmitted"
        : "failed";
    } catch {
      result.google = "failed";
    }
  }

  return result;
}
