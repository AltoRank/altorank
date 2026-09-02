/**
 * Agent-readiness checks: can an AI agent actually read this site?
 *
 * TypeScript port of tools/agent-readiness/agent_readiness.py (the Python
 * checker was verified against Cloudflare's isitagentready.com scanner on
 * 2026-08-15 across 272 live agency sites). Scoring is identical on purpose,
 * so numbers from the two implementations are comparable.
 *
 * This module is deliberately self-contained — no Supabase, no Next, no
 * imports from @/lib/types — so it lifts into packages/core unchanged when
 * the public repo seeds. The fetcher is injectable for the same reason tests
 * shouldn't need a network.
 *
 * Three lessons from the Python version are load-bearing here; each cost a
 * false finding in production before it was learned:
 *
 * 1. JSON-LD @type collection must recurse. Yoast and most WordPress schema
 *    plugins emit one block shaped {"@context":..., "@graph":[...]}. Reading
 *    only top-level @type reported 32% schema adoption where the truth was 94%.
 * 2. The User-Agent must be browser-shaped (while staying honestly
 *    identified). A bare tool UA gets a WAF challenge or a stripped page from
 *    a good share of real sites, which reads as "no structured data" on sites
 *    that plainly have it.
 * 3. A 5xx or 403 on /robots.txt is "the server refused us", not "you have no
 *    robots.txt". Reporting the second when the first happened is a false
 *    claim about someone's site.
 */

import { fetchLenient, isTlsChainError } from "./lenient-fetch";

export type ReadinessSeverity = "high" | "medium" | "low";

export type ReadinessCheckId =
  | "robots_reachable"
  | "ai_crawlers_allowed"
  | "sitemap"
  | "structured_data"
  | "entity_schema"
  | "machine_readable"
  | "title_meta"
  | "single_h1"
  | "content_signals";

export interface ReadinessFinding {
  check: ReadinessCheckId;
  passed: boolean;
  severity: ReadinessSeverity;
  detail: string;
}

export interface ReadinessResult {
  domain: string;
  findings: ReadinessFinding[];
  /** 0-100, severity-weighted. 0 with an error means the site wasn't analysable. */
  score: number;
  error?: string;
}

export interface FetchedResource {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type ResourceFetcher = (url: string) => Promise<FetchedResource>;

/**
 * The crawlers that decide whether a site exists inside AI assistants.
 * Checked individually because a site can welcome Googlebot and still block
 * every one of these.
 */
export const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "PerplexityBot",
  "Google-Extended",
  "CCBot",
  "Applebot-Extended",
] as const;

/** A blocked AI crawler outweighs a missing h1 by a lot. */
const WEIGHTS: Record<ReadinessSeverity, number> = { high: 3, medium: 2, low: 1 };

/** Schema types that make the site a resolvable entity, not just a document. */
const ENTITY_TYPES = new Set([
  "Organization",
  "LocalBusiness",
  "Corporation",
  "ProfessionalService",
]);

// Lesson 2: browser-shaped but honestly identified.
const USER_AGENT =
  "Mozilla/5.0 (compatible; AltoRank-AgentReadiness/1.0; " +
  "+https://altorank.co; site readiness audit)";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 1_500_000;

/** Default fetcher. Never throws; unreachable is {status: 0}. */
export const defaultFetcher: ResourceFetcher = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      redirect: "follow",
    });
    const body = (await res.text()).slice(0, MAX_BODY_BYTES);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, headers, body };
  } catch (err) {
    // A chain Node cannot verify is not "unreachable". Read it anyway and
    // let the checks see the real robots.txt and homepage; the incomplete
    // chain is reported by the crawl audit, which sees the same flag.
    if (isTlsChainError(err)) {
      try {
        const r = await fetchLenient(url, { userAgent: USER_AGENT, timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_BODY_BYTES });
        return { status: r.status, headers: r.headers, body: r.body };
      } catch {
        return { status: 0, headers: {}, body: "" };
      }
    }
    return { status: 0, headers: {}, body: "" };
  } finally {
    clearTimeout(timeout);
  }
};

// ── robots.txt ────────────────────────────────────────────────────────────────

interface RobotsGroup {
  agents: string[];
  allowRoot: boolean;
  disallowRoot: boolean;
}

/**
 * Minimal robots.txt model, scoped to the one question we ask: may this bot
 * fetch the homepage? Only rules whose path matches "/" apply to that ("/",
 * "/*", or the no-op empty Disallow), so full longest-match path semantics
 * are not needed. On a root-level Allow/Disallow tie the least restrictive
 * rule wins, per Google's documented tie-break.
 */
export function parseRobotsGroups(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let agentRun = false; // consecutive User-agent lines share one group

  for (const raw of body.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();

    if (field === "user-agent") {
      if (!agentRun || !current) {
        current = { agents: [], allowRoot: false, disallowRoot: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      agentRun = true;
      continue;
    }
    agentRun = false;
    if (!current) continue;

    if (field === "allow" || field === "disallow") {
      const path = value.replace(/\*+$/, ""); // "/*" and "/" both match root
      const matchesRoot = path === "/" || path === "";
      if (!matchesRoot) continue;
      if (field === "allow" && path === "/") current.allowRoot = true;
      // Empty Disallow explicitly means "nothing disallowed" per the spec.
      if (field === "disallow" && path === "/") current.disallowRoot = true;
    }
  }
  return groups;
}

/** Which of the given bots may not fetch the homepage. */
export function blockedCrawlers(
  robotsBody: string,
  bots: readonly string[] = AI_CRAWLERS,
): string[] {
  const groups = parseRobotsGroups(robotsBody);
  const blocked: string[] = [];

  for (const bot of bots) {
    const lower = bot.toLowerCase();
    // A group naming the bot specifically overrides the * group entirely.
    const specific = groups.filter((g) =>
      g.agents.some((a) => a !== "*" && (lower.includes(a) || a.includes(lower))),
    );
    const applicable = specific.length
      ? specific
      : groups.filter((g) => g.agents.includes("*"));
    const disallowed = applicable.some((g) => g.disallowRoot && !g.allowRoot);
    if (disallowed) blocked.push(bot);
  }
  return blocked;
}

// ── JSON-LD ───────────────────────────────────────────────────────────────────

/** Every @type in the page's JSON-LD blocks, however deeply nested (lesson 1). */
export function collectJsonLdTypes(html: string): string[] {
  const blocks = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].map((m) => m[1]);

  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const t = record["@type"];
    if (Array.isArray(t)) found.push(...t.map(String));
    else if (t) found.push(String(t));
    for (const value of Object.values(record)) {
      if (typeof value === "object" && value !== null) walk(value);
    }
  };

  for (const block of blocks) {
    try {
      walk(JSON.parse(block.trim()));
    } catch {
      // Malformed JSON-LD contributes nothing rather than failing the run.
    }
  }
  return found;
}

// ── the run ───────────────────────────────────────────────────────────────────

function score(findings: ReadinessFinding[]): number {
  const total = findings.reduce((s, f) => s + WEIGHTS[f.severity], 0);
  if (total === 0) return 0;
  const earned = findings
    .filter((f) => f.passed)
    .reduce((s, f) => s + WEIGHTS[f.severity], 0);
  return Math.round((100 * earned) / total);
}

/**
 * Run all nine checks against a domain.
 *
 * Network access is confined to the injected fetcher: homepage, /robots.txt,
 * /sitemap.xml, /llms.txt. Public site configuration only — nothing here reads
 * content beyond the homepage or touches anything personal.
 */
export async function runAgentReadiness(
  rawDomain: string,
  fetcher: ResourceFetcher = defaultFetcher,
): Promise<ReadinessResult> {
  const domain = rawDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const base = `https://${domain}`;
  const findings: ReadinessFinding[] = [];

  const home = await fetcher(`${base}/`);
  if (home.status === 0) {
    return { domain, findings, score: 0, error: "unreachable over https" };
  }
  if (home.status >= 400) {
    return { domain, findings, score: 0, error: `homepage returned ${home.status}` };
  }

  // 1. robots.txt reachable (lesson 3: refused !== absent)
  const robots = await fetcher(`${base}/robots.txt`);
  const robotsOk = robots.status >= 200 && robots.status < 300 && robots.body.trim() !== "";
  findings.push({
    check: "robots_reachable",
    passed: robotsOk,
    severity: "medium",
    detail: robotsOk
      ? "robots.txt found"
      : robots.status >= 400 && robots.status !== 404
        ? `server returned ${robots.status} for /robots.txt, not conclusive`
        : "no robots.txt, crawlers get no guidance",
  });

  // 2. AI crawlers allowed — the finding that opens conversations
  const blocked = robotsOk ? blockedCrawlers(robots.body) : [];
  findings.push({
    check: "ai_crawlers_allowed",
    passed: blocked.length === 0,
    severity: "high",
    detail: blocked.length === 0
      ? "all major AI crawlers allowed"
      : `blocked: ${blocked.join(", ")}`,
  });

  // 3. sitemap declared or discoverable
  const declared = [...(robots.body || "").matchAll(/^\s*sitemap:\s*(\S+)/gim)];
  let sitemapOk = declared.length > 0;
  let sitemapDetail = `declared in robots.txt (${declared.length})`;
  if (!sitemapOk) {
    const probe = await fetcher(`${base}/sitemap.xml`);
    sitemapOk = probe.status >= 200 && probe.status < 300;
    sitemapDetail = sitemapOk ? "/sitemap.xml reachable" : "no sitemap declared or at /sitemap.xml";
  }
  findings.push({ check: "sitemap", passed: sitemapOk, severity: "medium", detail: sitemapDetail });

  // 4 + 5. structured data and entity schema
  const types = collectJsonLdTypes(home.body);
  const uniqueTypes = [...new Set(types)].sort();
  findings.push({
    check: "structured_data",
    passed: types.length > 0,
    severity: "high",
    detail: types.length
      ? `JSON-LD present: ${uniqueTypes.slice(0, 5).join(", ")}`
      : "no JSON-LD on the homepage",
  });
  const hasEntity = uniqueTypes.some((t) => ENTITY_TYPES.has(t));
  findings.push({
    check: "entity_schema",
    passed: hasEntity,
    severity: "high",
    detail: hasEntity
      ? "Organization-type schema present"
      : "no Organization schema, the site is not a resolvable entity",
  });

  // 6. machine-readable copy of the content
  //
  // Status alone is not enough. A site that 301s /llms.txt to its homepage
  // returns 200 text/html after the redirect and would pass, which is how
  // cloudflare.com and agenziabrand.it were recorded as having an llms.txt they
  // do not have. Require a non-HTML body that is not just a redirect landing.
  const llms = await fetcher(`${base}/llms.txt`);
  const llmsType = (llms.headers["content-type"] ?? "").toLowerCase();
  const llmsBody = llms.body.trimStart();
  const llmsOk =
    llms.status >= 200 &&
    llms.status < 300 &&
    !llmsType.includes("html") &&
    !llmsBody.startsWith("<") &&
    llmsBody.length > 20;
  const negotiated = (home.headers["content-type"] ?? "").includes("markdown");
  findings.push({
    check: "machine_readable",
    passed: llmsOk || negotiated,
    severity: "medium",
    detail: llmsOk
      ? "/llms.txt present"
      : negotiated
        ? "serves markdown"
        : "no /llms.txt or markdown version",
  });

  // 7. title + meta description
  const title = home.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const desc = home.body
    .match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i)?.[1]
    ?.trim();
  const bothPresent = Boolean(title) && Boolean(desc);
  findings.push({
    check: "title_meta",
    passed: bothPresent,
    severity: "low",
    detail: bothPresent
      ? "title and meta description present"
      : "missing title or meta description",
  });

  // 8. single h1
  const h1Count = (home.body.match(/<h1[\s>]/gi) ?? []).length;
  findings.push({
    check: "single_h1",
    passed: h1Count === 1,
    severity: "low",
    detail: h1Count === 1 ? "one h1" : `${h1Count} h1 elements`,
  });

  // 9. content signals (informational; the proposal is young)
  const hasSignal = /^\s*content-signal:/im.test(robots.body || "");
  findings.push({
    check: "content_signals",
    passed: hasSignal,
    severity: "low",
    detail: hasSignal
      ? "content-signal directive present"
      : "no content-signal directive (optional, emerging)",
  });

  return { domain, findings, score: score(findings) };
}
