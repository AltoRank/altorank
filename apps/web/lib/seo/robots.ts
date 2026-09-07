// ---------------------------------------------------------------------------
// robots.txt, as a crawler has to read it
// ---------------------------------------------------------------------------
//
// `lib/audit/agent-readiness.ts` already parses robots.txt, and deliberately
// only far enough to answer one question: may GPTBot fetch the homepage? Its
// parser drops every rule whose path is not "/", because that is all that
// question needs.
//
// A crawler that walks a whole sitemap asks a different question, once per
// URL: may I fetch THIS path? That needs the real thing - wildcards, `$`
// anchors, and the longest-match tie-break RFC 9309 specifies - so this is a
// second, fuller parser rather than a widening of the first. Widening the
// first would have changed what the readiness check reports, which is a
// customer-visible score.
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

/** One `Allow:` or `Disallow:` line, kept as written so length can break ties. */
interface RobotsRule {
  allow: boolean;
  /** The raw path pattern, `*` and `$` included. */
  pattern: string;
  /** Pattern length, the RFC's tie-break: the most specific rule wins. */
  length: number;
}

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
 * A pattern as a regular expression.
 *
 * `*` is any run of characters, `$` at the end anchors, and everything else is
 * literal. Matching is against the path plus query, which is what the RFC
 * says the rule applies to.
 */
function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

/**
 * The rules that apply to `userAgent`.
 *
 * Group selection follows the RFC: a group naming the agent (case-insensitive
 * substring, as every real robots.txt is written) beats the `*` group
 * entirely, and consecutive `User-agent:` lines share one group's rules.
 */
export function parseRobots(body: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();

  interface Group {
    agents: string[];
    rules: RobotsRule[];
    crawlDelay: number | null;
  }
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let agentRun = false;

  for (const raw of body.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!agentRun || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      agentRun = true;
      continue;
    }
    agentRun = false;
    if (!current) continue;

    if (field === "crawl-delay") {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
      continue;
    }
    if (field !== "allow" && field !== "disallow") continue;
    // An empty `Disallow:` is the spec's "nothing is disallowed" and carries
    // no pattern; an empty `Allow:` says nothing at all.
    if (!value) continue;
    current.rules.push({ allow: field === "allow", pattern: value, length: value.length });
  }

  const named = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && a !== "" && (ua.includes(a) || a.includes(ua))),
  );
  const applicable = named.length ? named : groups.filter((g) => g.agents.includes("*"));

  const rules = applicable.flatMap((g) => g.rules);
  const delays = applicable.map((g) => g.crawlDelay).filter((d): d is number => d !== null);

  return {
    source: "fetched",
    rules,
    crawlDelaySeconds: delays.length ? Math.max(...delays) : null,
    sitemaps,
    // A file we could read that says nothing about us allows everything.
    allowAll: true,
  };
}

/**
 * Whether `url` may be fetched.
 *
 * Longest matching pattern wins; on an exact tie `Allow` wins, which is
 * Google's documented behaviour and the least surprising for a site owner who
 * wrote both lines.
 */
export function isAllowed(rules: RobotsRules, url: string): boolean {
  if (!rules.rules.length) return rules.allowAll;
  let target: string;
  try {
    const u = new URL(url);
    target = u.pathname + u.search;
  } catch {
    target = url;
  }

  let best: RobotsRule | null = null;
  for (const rule of rules.rules) {
    if (!patternToRegExp(rule.pattern).test(target)) continue;
    if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : rules.allowAll;
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
  if (res.status >= 500 || res.status === 0 || res.body === null) return ALLOW_NOTHING;
  if (res.status >= 400) return ALLOW_EVERYTHING;
  // A 200 that is HTML is a soft 404: a site serving its own error page for a
  // missing file. Treating that markup as rules produces nonsense patterns.
  if (/^\s*<(!doctype|html)/i.test(res.body)) return ALLOW_EVERYTHING;
  return parseRobots(res.body, userAgent);
}
