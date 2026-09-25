// ---------------------------------------------------------------------------
// robots.txt for the public tools: RFC 9309, with the matching rule shown
// ---------------------------------------------------------------------------
//
// The app has two robots parsers already and neither fits here:
//
//   - lib/audit/agent-readiness.ts keeps only rules for "/", because it
//     answers one question about the homepage.
//   - lib/seo/robots.ts matches paths correctly but selects groups by
//     substring in both directions, so a `User-agent: Googlebot-Image` group
//     is applied to Googlebot, and it does not say WHICH rule decided. A
//     tester that cannot show the deciding line is not a tester.
//
// So this one follows RFC 9309 and reports its reasoning:
//
//   - Groups: consecutive `User-agent` lines share the rules that follow.
//     A group applies when one of its agents equals the crawler's product
//     token, case-insensitively. Every matching group is merged (§2.2.1);
//     with none, the `*` groups apply; with no `*` either, everything is
//     allowed.
//   - Rules: the longest matching pattern wins; on a tie `Allow` wins.
//     `*` matches any run of characters, a trailing `$` anchors the end.
//     An empty `Disallow:` allows everything. /robots.txt itself is always
//     allowed (§2.2.2).
//   - Fetching (§2.3.1): up to five redirects; 4xx other than 429 means no
//     file, so everything is allowed; 5xx, 429 or no answer means the site
//     is unreachable, and a well-behaved crawler fetches nothing. Parsing
//     stops at 500 KiB, the minimum the RFC requires crawlers to read.

import type { SafeFetch } from "./safe-fetch";
import { FetchFailedError, UnsafeUrlError } from "./safe-fetch";

export const ROBOTS_MAX_BYTES = 500 * 1024;

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
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  /** Lines that are not a recognised `field: value`. Shown as warnings. */
  unknownLines: Array<{ line: number; text: string }>;
}

const KNOWN_OTHER_FIELDS = new Set(["crawl-delay", "host", "clean-param", "request-rate", "visit-time", "noindex", "content-signal"]);

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
        current = { agents: [], rules: [], line };
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
  const hit = [...known].sort((a, b) => b.length - a.length).find((k) => new RegExp(`(^|[^a-z-])${k.toLowerCase()}([^a-z-]|$)`).test(lower));
  if (hit) return hit;
  return ua.split(/[\s/;()]/).find(Boolean) ?? ua;
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

export interface RobotsVerdict {
  allowed: boolean;
  /** The rule that decided, or null when no rule matched (or no group applied). */
  rule: RobotsRule | null;
  /** Which group applied: the agent name as written in the file, "*", or null when none. */
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
  const t = token.toLowerCase();
  let applicable = parsed.groups.filter((g) => g.agents.includes(t));
  let group: string | null = applicable.length ? token : null;
  if (!applicable.length) {
    applicable = parsed.groups.filter((g) => g.agents.includes("*"));
    group = applicable.length ? "*" : null;
  }
  if (pathAndQuery === "/robots.txt") return { allowed: true, rule: null, group };

  let best: RobotsRule | null = null;
  for (const g of applicable) {
    for (const rule of g.rules) {
      if (!patternMatches(rule.pattern, pathAndQuery)) continue;
      const len = normalisePath(rule.pattern).length;
      const bestLen = best ? normalisePath(best.pattern).length : -1;
      if (len > bestLen || (len === bestLen && rule.allow && !best?.allow)) best = rule;
    }
  }
  return { allowed: best ? best.allow : true, rule: best, group };
}

export function describeRule(rule: RobotsRule | null): string {
  return rule ? `${rule.allow ? "Allow" : "Disallow"}: ${rule.pattern} (line ${rule.line})` : "no rule matches";
}

// ── fetching ──────────────────────────────────────────────────────────────────

export type RobotsState =
  /** A file was read. Its rules apply. */
  | "fetched"
  /** 4xx (not 429): no file, everything is allowed. */
  | "missing"
  /** 5xx, 429 or no answer: a well-behaved crawler fetches nothing. */
  | "unreachable";

export interface RobotsLoad {
  url: string;
  state: RobotsState;
  status: number | null;
  body: string;
  parsed: ParsedRobots;
  truncated: boolean;
  /** Where the file actually came from, after redirects. */
  finalUrl: string;
  error?: string;
}

const EMPTY: ParsedRobots = { groups: [], sitemaps: [], unknownLines: [] };

export async function loadRobotsTxt(
  pageUrl: string,
  fetch: SafeFetch,
  opts: { signal?: AbortSignal; userAgent?: string } = {},
): Promise<RobotsLoad> {
  const url = `${new URL(pageUrl).origin}/robots.txt`;
  try {
    const res = await fetch(url, {
      signal: opts.signal,
      userAgent: opts.userAgent,
      maxBytes: ROBOTS_MAX_BYTES,
      maxRedirects: 5,
      headers: { Accept: "text/plain,*/*;q=0.5" },
    });
    if (res.status >= 500 || res.status === 429) {
      return { url, state: "unreachable", status: res.status, body: "", parsed: EMPTY, truncated: false, finalUrl: res.url };
    }
    if (res.status >= 400 || res.status < 200 || res.status >= 300) {
      return { url, state: "missing", status: res.status, body: "", parsed: EMPTY, truncated: false, finalUrl: res.url };
    }
    // A 200 that is an HTML page is a soft 404: the site's error page. Rules
    // parsed out of markup are nonsense, so it counts as no file.
    if (/^\s*<(!doctype|html|head|body)/i.test(res.body)) {
      return { url, state: "missing", status: res.status, body: res.body, parsed: EMPTY, truncated: res.truncated, finalUrl: res.url, error: "served an HTML page, not a robots.txt file" };
    }
    return { url, state: "fetched", status: res.status, body: res.body, parsed: parseRobotsTxt(res.body), truncated: res.truncated, finalUrl: res.url };
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    const reason = err instanceof FetchFailedError ? err.message : "the request failed";
    // §2.3.1.2: a file not reached within five redirects MAY be treated as
    // unavailable, which allows everything, rather than as unreachable.
    if (/redirected more than|redirects in a loop/.test(reason)) {
      return { url, state: "missing", status: null, body: "", parsed: EMPTY, truncated: false, finalUrl: url, error: reason };
    }
    return { url, state: "unreachable", status: null, body: "", parsed: EMPTY, truncated: false, finalUrl: url, error: reason };
  }
}

/** The verdict for one crawler, with the unreachable/missing states folded in. */
export function robotsVerdictFor(load: RobotsLoad, token: string, pageUrl: string): RobotsVerdict & { summary: string } {
  if (load.state === "unreachable") {
    return { allowed: false, rule: null, group: null, summary: "blocked: robots.txt could not be read, so crawlers stay out" };
  }
  if (load.state === "missing") {
    return { allowed: true, rule: null, group: null, summary: "allowed: no robots.txt" };
  }
  const v = evaluateRobots(load.parsed, token, robotsTarget(pageUrl));
  const via = v.group === null ? "no group applies" : v.group === "*" ? "group *" : `group ${v.group}`;
  return { ...v, summary: `${v.allowed ? "allowed" : "blocked"}: ${describeRule(v.rule)}, ${via}` };
}
