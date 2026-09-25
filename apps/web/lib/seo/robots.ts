// ---------------------------------------------------------------------------
// robots.txt, as a crawler has to read it
// ---------------------------------------------------------------------------
//
// A crawler that walks a whole sitemap asks one question per URL: may I fetch
// THIS path? Parsing and matching live in `lib/robots/rfc9309.ts`, shared with
// the readiness check; this file adds what only a crawler needs - what to do
// when the file cannot be read, and the crawl-delay it asked for.
//
// Unavailability is handled the way RFC 9309 §2.3.1.3 says, and the difference
// matters on a live site:
//
//   4xx  "unavailable": there are no rules, so everything is allowed. A site
//        with no robots.txt is the common case and must not read as forbidden.
//   5xx / network error  "unreachable": the server has rules and will not show
//        them, so a well-behaved crawler stops. This is the conservative half
//        and it is deliberate - a site that cannot answer for itself does not
//        get crawled by us, and the caller reports that honestly rather than
//        fetching anyway.
//
// Nothing here fetches on its own account: the caller injects the fetch so the
// SSRF guard in `lib/audit/lenient-fetch.ts` stays on the path and the parser
// stays testable without a network.

import { decidingRule, parseRobotsTxt, productToken, robotsTarget, selectGroups, type RobotsRule } from "../robots/rfc9309";

export interface RobotsRules {
  /**
   * How the file was obtained. `missing` and `error` both produce a verdict
   * with no rules; `allowAll` says which way that verdict goes.
   */
  source: "fetched" | "missing" | "error";
  rules: RobotsRule[];
  /** Seconds a `Crawl-delay` asked for, when one applied to us. */
  crawlDelaySeconds: number | null;
  /** Every `Sitemap:` line, in order. Global: they are not group-scoped. */
  sitemaps: string[];
  /** With no rules at all, whether the default is yes (missing) or no (error). */
  allowAll: boolean;
}

export const ALLOW_EVERYTHING: RobotsRules = {
  source: "missing",
  rules: [],
  crawlDelaySeconds: null,
  sitemaps: [],
  allowAll: true,
};

export const ALLOW_NOTHING: RobotsRules = {
  source: "error",
  rules: [],
  crawlDelaySeconds: null,
  sitemaps: [],
  allowAll: false,
};

/**
 * The rules that apply to `userAgent`.
 *
 * Group selection and matching are RFC 9309's, from `lib/robots/rfc9309.ts`:
 * a group applies when it names our product token exactly (case-insensitive),
 * and such a group replaces the `*` group entirely. A `Googlebot-Image` group
 * is not ours because our name is a substring of it, nor the other way round.
 */
export function parseRobots(body: string, userAgent: string): RobotsRules {
  const parsed = parseRobotsTxt(body);
  const { groups } = selectGroups(parsed, productToken(userAgent));
  const delays = groups.map((g) => g.crawlDelay).filter((d): d is number => d !== null);

  return {
    source: "fetched",
    rules: groups.flatMap((g) => g.rules),
    crawlDelaySeconds: delays.length ? Math.max(...delays) : null,
    sitemaps: parsed.sitemaps,
    // A file we could read that says nothing about us allows everything.
    allowAll: true,
  };
}

/**
 * Whether `url` may be fetched.
 *
 * Longest matching pattern wins; on an exact tie `Allow` wins, which is what
 * RFC 9309 and Google both specify.
 */
export function isAllowed(rules: RobotsRules, url: string): boolean {
  if (!rules.rules.length) return rules.allowAll;
  const target = robotsTarget(url);
  if (target === "/robots.txt") return true;
  const rule = decidingRule(rules.rules, target);
  return rule ? rule.allow : rules.allowAll;
}

/** What a fetch of /robots.txt came back with. `null` body means no response. */
export interface RobotsFetchResult {
  status: number;
  body: string | null;
}

/**
 * Read a site's robots.txt through the caller's fetcher and turn it into rules.
 *
 * The fetcher is injected so the SSRF guard and the TLS-lenient retry in
 * `fetchSite` stay on the path, and so tests need no network. Anything the
 * fetcher throws is an "unreachable" verdict, per the header.
 */
export async function loadRobots(
  origin: string,
  userAgent: string,
  fetcher: (url: string) => Promise<RobotsFetchResult>,
): Promise<RobotsRules> {
  let res: RobotsFetchResult;
  try {
    res = await fetcher(`${origin.replace(/\/$/, "")}/robots.txt`);
  } catch {
    return ALLOW_NOTHING;
  }
  // Order matters: a 404 is "unavailable" and allows everything, and it also
  // arrives with a null body, so the 4xx test has to come first.
  if (res.status >= 500 || res.status === 0) return ALLOW_NOTHING;
  if (res.status >= 400 || res.body === null) return ALLOW_EVERYTHING;
  // A 200 that is HTML is a soft 404: a site serving its own error page for a
  // missing file. Treating that markup as rules produces nonsense patterns.
  if (/^\s*<(!doctype|html)/i.test(res.body)) return ALLOW_EVERYTHING;
  return parseRobots(res.body, userAgent);
}
