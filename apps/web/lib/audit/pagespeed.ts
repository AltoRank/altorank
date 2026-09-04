export interface PageSpeedResult {
  performanceScore: number;
  firstContentfulPaint: number;
  largestContentfulPaint: number;
  cumulativeLayoutShift: number;
  totalBlockingTime: number;
  speedIndex: number;
}

export type PageSpeedOutcome =
  | { ok: true; result: PageSpeedResult }
  /**
   * `unavailable` is a configuration or quota problem on our side and is worth
   * telling the operator about. `failed` means Google could not analyse that
   * particular URL, which is a fact about the site.
   */
  | { ok: false; kind: "unavailable" | "failed"; detail: string };

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/**
 * Lighthouse runs on Google's machines, and the default fetch timeout is no
 * timeout at all, which would let one bad URL hold a crawl open indefinitely.
 *
 * 60s per attempt, twice, rather than 90s once. Measured against fitsuite.co
 * on 2026-09-04: mobile answered in 32s and desktop in 23s, yet the same URL
 * had timed out at 90s inside an analysis run twenty minutes earlier. So the
 * call is not slow, it is occasionally queued - which a longer wait does not
 * fix and a second attempt does. Two 60s attempts also bound the worst case
 * below the single 90s one plus its retry, which matters because the analyze
 * cron has 300s for every layer and PageSpeed was eating 80% of it on the run
 * that failed.
 */
const TIMEOUT_MS = 60_000;
const ATTEMPTS = 2;

function extract(lighthouse: {
  categories?: { performance?: { score?: number | null } };
  audits?: Record<string, { numericValue?: number }>;
}): PageSpeedResult {
  const audits = lighthouse.audits ?? {};
  return {
    performanceScore: Math.round((lighthouse.categories?.performance?.score ?? 0) * 100),
    firstContentfulPaint: audits["first-contentful-paint"]?.numericValue ?? 0,
    largestContentfulPaint: audits["largest-contentful-paint"]?.numericValue ?? 0,
    cumulativeLayoutShift: audits["cumulative-layout-shift"]?.numericValue ?? 0,
    totalBlockingTime: audits["total-blocking-time"]?.numericValue ?? 0,
    speedIndex: audits["speed-index"]?.numericValue ?? 0,
  };
}

/**
 * Fetch PageSpeed Insights, reporting why it failed when it does.
 *
 * The previous version returned null for every failure mode, so "no API key",
 * "quota exhausted", "key rejected" and "Google could not load the page" were
 * indistinguishable. The audit surfaced all four as the same shrug, and the one
 * that is trivially fixable (set a key) looked identical to the one that is not.
 *
 * PAGESPEED_API_KEY is optional. Google allows unkeyed requests at a low
 * enough rate limit that any real use gets 429s, so an unkeyed install is
 * reported as `unavailable` rather than silently producing nothing.
 */
export async function fetchPageSpeedDetailed(
  url: string,
  strategy: "mobile" | "desktop" = "mobile",
): Promise<PageSpeedOutcome> {
  const apiKey = process.env.PAGESPEED_API_KEY?.trim();

  const params = new URLSearchParams({
    url,
    strategy,
    category: "performance",
    ...(apiKey ? { key: apiKey } : {}),
  });

  let lastTransient: PageSpeedOutcome | null = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const outcome = await attemptOnce(`${ENDPOINT}?${params}`, apiKey, attempt);
    if (outcome.ok || !outcome.transient) return strip(outcome);
    lastTransient = strip(outcome);
  }

  return lastTransient!;
}

/** Drop the internal `transient` flag before the outcome leaves this module. */
function strip(o: Attempt): PageSpeedOutcome {
  if (o.ok) return { ok: true, result: o.result };
  return { ok: false, kind: o.kind, detail: o.detail };
}

/**
 * One request. `transient` marks the failures worth trying again - a timeout
 * or a 5xx from Google - as opposed to a rejected key or a page Lighthouse
 * genuinely cannot load, where a second identical request wastes 60 seconds
 * to produce the same answer.
 */
type Attempt =
  | { ok: true; result: PageSpeedResult; transient?: false }
  | { ok: false; kind: "unavailable" | "failed"; detail: string; transient: boolean };

async function attemptOnce(url: string, apiKey: string | undefined, attempt: number): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      // Google returns a structured error; its message names the actual cause.
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: string; status?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {
        // Non-JSON error body; the status code is all we have.
      }

      if (res.status === 429) {
        return {
          ok: false,
          kind: "unavailable",
          detail: apiKey
            ? `PageSpeed quota exhausted: ${message}`
            : "PageSpeed rate limit hit; set PAGESPEED_API_KEY to raise it",
          // A quota does not refill in the second it takes to ask again.
          transient: false,
        };
      }
      if (res.status === 400 || res.status === 403) {
        return {
          ok: false,
          kind: "unavailable",
          detail: `PageSpeed rejected the request: ${message}`,
          transient: false,
        };
      }
      return { ok: false, kind: "failed", detail: message, transient: res.status >= 500 };
    }

    const data = (await res.json()) as { lighthouseResult?: Parameters<typeof extract>[0] };
    if (!data.lighthouseResult) {
      return {
        ok: false,
        kind: "failed",
        detail: "PageSpeed returned no Lighthouse result",
        transient: false,
      };
    }

    return { ok: true, result: extract(data.lighthouseResult) };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        kind: "failed",
        detail:
          attempt >= ATTEMPTS
            ? `PageSpeed timed out after ${TIMEOUT_MS / 1000}s, twice`
            : `PageSpeed timed out after ${TIMEOUT_MS / 1000}s`,
        transient: true,
      };
    }
    return {
      ok: false,
      kind: "failed",
      detail: err instanceof Error ? err.message : "PageSpeed request failed",
      transient: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Back-compatible wrapper for callers that only care whether it worked. */
export async function fetchPageSpeed(
  url: string,
  strategy: "mobile" | "desktop" = "mobile",
): Promise<PageSpeedResult | null> {
  const outcome = await fetchPageSpeedDetailed(url, strategy);
  return outcome.ok ? outcome.result : null;
}
