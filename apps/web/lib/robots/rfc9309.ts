// ---------------------------------------------------------------------------
// robots.txt matching, RFC 9309, with the deciding rule reported
// ---------------------------------------------------------------------------
//
// The one robots.txt matcher in the app. Every caller that asks "may crawler
// X fetch path Y" goes through `evaluateRobots`:
//
//   - lib/audit/agent-readiness.ts   may each AI crawler fetch "/" (/check)
//   - lib/seo/robots.ts              may our site crawler fetch this URL
//
// There used to be one parser per caller, and both selected groups by
// substring in both directions: a `User-agent: Googlebot-Image` group was
// applied to Googlebot, `User-agent: Applebot` to Applebot-Extended, and a
// short token like `bot` to every crawler whose name contains it. That is not
// what any crawler does, so the verdicts were wrong in both directions.
//
// What this implements:
//
//   - Groups: consecutive `User-agent` lines share the rules that follow.
//     A group applies when one of its agents EQUALS the crawler's product
//     token, case-insensitively ("GPTBot/1.0" in the file names GPTBot).
//     Every matching group is merged (§2.2.1); with none, the `*` groups
//     apply; with no `*` either, everything is allowed.
//   - Rules: the longest matching pattern wins; on a tie `Allow` wins.
//     `*` matches any run of characters, a trailing `$` anchors the end.
//     An empty `Disallow:` allows everything. /robots.txt itself is always
//     allowed (§2.2.2).
//
// Pure: nothing here fetches. Availability (4xx allows everything, 5xx or no
// answer allows nothing) is the caller's half, because each caller fetches
// through its own SSRF-guarded client.
//
// Lifted from the public tools' tester (PR #243), which reports the deciding
// line to the user; `tools/agent-readiness/agent_readiness.py` mirrors the
// group selection and "/" verdict so the TS and Python scores agree.

export interface RobotsRule {
  allow: boolean;
  pattern: string;
  /** 1-based line in the file, for "decided by line N". */
  line: number;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  line: number;
  /** Seconds a `Crawl-delay` in this group asked for. Not in the RFC; widely sent. */
  crawlDelay: number | null;
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  /** Lines that are not a recognised `field: value`. Shown as warnings. */
  unknownLines: Array<{ line: number; text: string }>;
}

const KNOWN_OTHER_FIELDS = new Set(["host", "clean-param", "request-rate", "visit-time", "noindex", "content-signal"]);

export function parseRobotsTxt(body: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const unknownLines: ParsedRobots["unknownLines"] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  const lines = body.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const content = raw.replace(/#.*$/, "").trim();
    if (!content) return;
    const m = content.match(/^([A-Za-z][A-Za-z_-]*)\s*:\s*(.*)$/);
    if (!m) {
      unknownLines.push({ line, text: raw.trim().slice(0, 200) });
      return;
    }
    const field = m[1].toLowerCase().replace(/_/g, "-");
    const value = m[2].trim();

    if (field === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [], line, crawlDelay: null };
        groups.push(current);
      }
      // "GPTBot/1.0" and "GPTBot" name the same crawler.
      const agent = value.split(/[\s/]/)[0].toLowerCase();
      if (agent) current.agents.push(agent);
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      return;
    }
    if (field === "allow" || field === "disallow") {
      if (!current) {
        unknownLines.push({ line, text: `${raw.trim().slice(0, 200)} (a rule before any User-agent line is ignored)` });
        return;
      }
      if (value) current.rules.push({ allow: field === "allow", pattern: value, line });
      return;
    }
    if (field === "crawl-delay") {
      const n = Number.parseFloat(value);
      if (current && Number.isFinite(n) && n >= 0) current.crawlDelay = n;
      return;
    }
    if (!KNOWN_OTHER_FIELDS.has(field)) unknownLines.push({ line, text: raw.trim().slice(0, 200) });
  });

  return { groups, sitemaps, unknownLines };
}

/**
 * The product token of a user agent: "GPTBot" from "GPTBot", from
 * "GPTBot/1.1" and from a full browser-shaped string when `known` lists it.
 */
export function productToken(userAgent: string, known: readonly string[] = []): string {
  const ua = userAgent.trim();
  if (/^[A-Za-z_-]+$/.test(ua)) return ua;
  const lower = ua.toLowerCase();
  const hit = [...known]
    .sort((a, b) => b.length - a.length)
    .find((k) => new RegExp(`(^|[^a-z-])${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z-]|$)`).test(lower));
  if (hit) return hit;
  return ua.split(/[\s/;()]/).find(Boolean) ?? ua;
}

/**
 * The groups that apply to `token`: every group naming it exactly, else every
 * `*` group, else none. `name` is what to call the choice in a verdict.
 */
export function selectGroups(parsed: ParsedRobots, token: string): { groups: RobotsGroup[]; name: string | null } {
  const t = token.toLowerCase();
  const named = parsed.groups.filter((g) => g.agents.includes(t));
  if (named.length) return { groups: named, name: token };
  const star = parsed.groups.filter((g) => g.agents.includes("*"));
  return { groups: star, name: star.length ? "*" : null };
}

/** Normalise percent-escapes to upper case and encode non-ASCII, for both sides of a match. */
function normalisePath(s: string): string {
  return s
    .replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase())
    .replace(/[\u0080-\u{10FFFF}]/gu, (c) => {
      try {
        return encodeURIComponent(c);
      } catch {
        return c; // a lone surrogate: leave it, it can only match itself
      }
    });
}

function patternMatches(pattern: string, path: string): boolean {
  const p = normalisePath(pattern);
  const anchored = p.endsWith("$");
  const body = anchored ? p.slice(0, -1) : p;
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(normalisePath(path));
}

/**
 * The rule among `rules` that decides `pathAndQuery`: the longest matching
 * pattern, `Allow` on a tie. Null when nothing matches, which means allowed.
 */
export function decidingRule(rules: readonly RobotsRule[], pathAndQuery: string): RobotsRule | null {
  let best: RobotsRule | null = null;
  let bestLen = -1;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, pathAndQuery)) continue;
    const len = normalisePath(rule.pattern).length;
    if (len > bestLen || (len === bestLen && rule.allow && !best?.allow)) {
      best = rule;
      bestLen = len;
    }
  }
  return best;
}

export interface RobotsVerdict {
  allowed: boolean;
  /** The rule that decided, or null when no rule matched (or no group applied). */
  rule: RobotsRule | null;
  /** Which group applied: the token as asked, "*", or null when none. */
  group: string | null;
}

/** Path plus query, which is what a rule is matched against. */
export function robotsTarget(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname || "/") + u.search;
  } catch {
    return url;
  }
}

export function evaluateRobots(parsed: ParsedRobots, token: string, pathAndQuery: string): RobotsVerdict {
  const { groups, name } = selectGroups(parsed, token);
  if (pathAndQuery === "/robots.txt") return { allowed: true, rule: null, group: name };
  const rule = decidingRule(groups.flatMap((g) => g.rules), pathAndQuery);
  return { allowed: rule ? rule.allow : true, rule, group: name };
}

export function describeRule(rule: RobotsRule | null): string {
  return rule ? `${rule.allow ? "Allow" : "Disallow"}: ${rule.pattern} (line ${rule.line})` : "no rule matches";
}
