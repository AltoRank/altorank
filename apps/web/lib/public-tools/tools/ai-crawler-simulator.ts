// ---------------------------------------------------------------------------
// AI crawler simulator: fetch one URL as each search and AI crawler
// ---------------------------------------------------------------------------
//
// For each crawler: what robots.txt says about this path, what the server
// answers to that crawler's user agent, and what a crawler that does not run
// JavaScript can read in the answer. Most AI crawlers do not render, so the
// raw HTML is exactly what they get.
//
// Two honest limits, both said in the output:
//   - We send the crawler's user agent from our own address. A site that
//     verifies crawlers by IP can treat us as an impostor, so a block here
//     may be a block on spoofed crawlers only.
//   - Google-Extended is a robots.txt token, not a crawler. Google fetches
//     with Googlebot; Google-Extended only says whether that content may be
//     used for Gemini. It gets a robots verdict and no fetch.

import { z } from "zod";
import { AI_CRAWLERS } from "@/lib/audit/agent-readiness";
import { defineTool, type ToolContext } from "../types";
import { publicUrl } from "../url";
import { kv, table, text, list, type Block, type KvItem } from "../blocks";
import { ToolError } from "../errors";
import { FetchFailedError, UnsafeUrlError, type SafeFetchResult } from "../safe-fetch";
import { loadRobotsTxt, robotsVerdictFor } from "../robots";
import { findElements, findTags, mapLimit, stripComments, titleOf, visibleText, wordCount, clip } from "../html";

export interface CrawlerSpec {
  name: string;
  /** robots.txt product token. */
  token: string;
  /** null: robots-only token, never fetched. */
  userAgent: string | null;
  operator: string;
  purpose: string;
}

export const CRAWLERS: CrawlerSpec[] = [
  {
    name: "Googlebot",
    token: "Googlebot",
    userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    operator: "Google",
    purpose: "Search index, and the pages AI Overviews draw on",
  },
  {
    name: "Bingbot",
    token: "Bingbot",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
    operator: "Microsoft",
    purpose: "Bing index, which Copilot and several assistants search",
  },
  {
    name: "GPTBot",
    token: "GPTBot",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)",
    operator: "OpenAI",
    purpose: "Model training",
  },
  {
    name: "OAI-SearchBot",
    token: "OAI-SearchBot",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
    operator: "OpenAI",
    purpose: "ChatGPT search results",
  },
  {
    name: "ChatGPT-User",
    token: "ChatGPT-User",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    operator: "OpenAI",
    purpose: "Fetches a page when a ChatGPT user asks about it",
  },
  {
    name: "ClaudeBot",
    token: "ClaudeBot",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    operator: "Anthropic",
    purpose: "Model training",
  },
  {
    name: "Claude-SearchBot",
    token: "Claude-SearchBot",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)",
    operator: "Anthropic",
    purpose: "Claude search results",
  },
  {
    name: "PerplexityBot",
    token: "PerplexityBot",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    operator: "Perplexity",
    purpose: "Perplexity search index",
  },
  {
    name: "Perplexity-User",
    token: "Perplexity-User",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
    operator: "Perplexity",
    purpose: "Fetches a page when a Perplexity user asks about it",
  },
  {
    name: "Google-Extended",
    token: "Google-Extended",
    userAgent: null,
    operator: "Google",
    purpose: "robots.txt token only: whether Googlebot's copy may be used for Gemini",
  },
];

/** AI tokens the readiness check also watches, reported as robots-only extras. */
const EXTRA_ROBOTS_TOKENS = AI_CRAWLERS.filter((t) => !CRAWLERS.some((c) => c.token === t));

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export interface PageRead {
  status: number;
  bytes: number;
  title: string | null;
  words: number;
  jsDependent: "yes" | "likely" | "no";
  challenge: boolean;
  finalUrl: string;
}

/**
 * Whether the main content needs JavaScript. Signals: little text, an empty
 * app root (#root, #__next, #app, #__nuxt, #svelte), a <noscript> that asks
 * for JavaScript, and a body that is mostly script tags.
 */
export function jsDependence(html: string, words: number): PageRead["jsDependent"] {
  const clean = stripComments(html);
  const emptyRoot = /<div[^>]+id=["'](root|__next|app|__nuxt|svelte|q-app)["'][^>]*>\s*<\/div>/i.test(clean);
  const noscriptAsks = findElements(clean, "noscript").some((n) => /javascript|enable js/i.test(n.inner));
  const scripts = findTags(clean, "script").length;
  if (words < 30 && (emptyRoot || noscriptAsks || scripts >= 3)) return "yes";
  if (words < 120 && (emptyRoot || noscriptAsks)) return "likely";
  return "no";
}

/** A bot-challenge page rather than the site: Cloudflare, Akamai, DataDome, captcha walls. */
export function looksLikeChallenge(res: Pick<SafeFetchResult, "status" | "headers" | "body">): boolean {
  if (res.headers["cf-mitigated"] === "challenge") return true;
  if (![403, 429, 503].includes(res.status)) return false;
  return /just a moment|attention required|captcha|cf-chl|challenge-platform|access denied|datadome|perimeterx|are you a robot/i.test(
    res.body.slice(0, 20_000),
  );
}

export function readPage(res: SafeFetchResult): PageRead {
  const words = wordCount(visibleText(res.body));
  return {
    status: res.status,
    bytes: res.bytes,
    title: titleOf(res.body),
    words,
    jsDependent: jsDependence(res.body, words),
    challenge: looksLikeChallenge(res),
    finalUrl: res.url,
  };
}

type Outcome = { ok: true; page: PageRead } | { ok: false; error: string };

async function fetchAs(url: string, ua: string, ctx: ToolContext): Promise<Outcome> {
  try {
    const res = await ctx.fetch(url, { userAgent: ua, signal: ctx.signal, timeoutMs: 12_000, maxBytes: 2_000_000 });
    return { ok: true, page: readPage(res) };
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new ToolError("invalid_input", err.message);
    return { ok: false, error: err instanceof FetchFailedError ? err.message : "the request failed" };
  }
}

/** Different from the browser baseline in a way that matters: status class, or most of the text gone. */
export function differsFromBaseline(page: PageRead, base: PageRead): string | null {
  if (page.challenge && !base.challenge) return "gets a bot challenge page";
  if (Math.floor(page.status / 100) !== Math.floor(base.status / 100) || (page.status >= 400) !== (base.status >= 400)) {
    return `gets HTTP ${page.status} where a browser gets ${base.status}`;
  }
  if (base.words >= 50 && page.words < base.words * 0.5) {
    return `sees ${page.words} words where a browser sees ${base.words}`;
  }
  if (page.finalUrl !== base.finalUrl) return `is redirected to ${page.finalUrl}`;
  return null;
}

const input = z.object({ url: publicUrl });

export const aiCrawlerSimulator = defineTool({
  slug: "ai-crawler-simulator",
  kind: "fetch",
  input,
  perIpLimit: { limit: 10, windowMs: 60 * 60 * 1000 },
  estimateCents: 0,
  async run({ url }, ctx) {
    const [robots, baseline] = await Promise.all([
      loadRobotsTxt(url, ctx.fetch, { signal: ctx.signal }),
      fetchAs(url, BROWSER_UA, ctx),
    ]);
    if (!baseline.ok) {
      throw new ToolError("upstream", `Could not fetch ${url} as a browser: ${baseline.error}.`);
    }
    const base = baseline.page;

    const fetchable = CRAWLERS.filter((c) => c.userAgent);
    const outcomes = await mapLimit(fetchable, 4, (c) => fetchAs(url, c.userAgent!, ctx));
    const byName = new Map(fetchable.map((c, i) => [c.name, outcomes[i]]));

    const rows: (string | number | null)[][] = [];
    const flags: string[] = [];
    const summary: KvItem[] = [];
    let blockedByRobots = 0;
    let blockedByServer = 0;

    for (const c of CRAWLERS) {
      const verdict = robotsVerdictFor(robots, c.token, url);
      if (!verdict.allowed) blockedByRobots++;
      const outcome = byName.get(c.name);
      if (!outcome) {
        rows.push([c.name, c.operator, verdict.summary, null, null, null, null, null, "robots.txt token only; not a separate crawler"]);
        summary.push({ label: c.name, value: verdict.allowed ? "allowed by robots.txt" : "blocked by robots.txt", status: verdict.allowed ? "pass" : "warn" });
        continue;
      }
      if (!outcome.ok) {
        blockedByServer++;
        rows.push([c.name, c.operator, verdict.summary, null, null, null, null, null, `request failed: ${outcome.error}`]);
        flags.push(`${c.name}: the request failed (${outcome.error}) while a browser request succeeded.`);
        summary.push({ label: c.name, value: `request failed: ${outcome.error}`, status: "fail" });
        continue;
      }
      const p = outcome.page;
      const diff = differsFromBaseline(p, base);
      if (diff) flags.push(`${c.name} ${diff}.`);
      const serverBlocks = p.status >= 400 || p.challenge;
      if (serverBlocks) blockedByServer++;
      rows.push([
        c.name,
        c.operator,
        verdict.summary,
        p.status,
        p.bytes,
        p.title ? clip(p.title, 80) : null,
        p.words,
        p.jsDependent,
        diff ?? (p.challenge ? "bot challenge page" : ""),
      ]);
      const status = !verdict.allowed || serverBlocks ? "fail" : diff || p.jsDependent !== "no" ? "warn" : "pass";
      const value = !verdict.allowed
        ? "blocked by robots.txt"
        : serverBlocks
          ? `server answers ${p.status}${p.challenge ? " (bot challenge)" : ""}`
          : diff
            ? diff
            : p.jsDependent !== "no"
              ? `reads ${p.words} words; content ${p.jsDependent === "yes" ? "needs" : "probably needs"} JavaScript`
              : `reads ${p.words} words`;
      summary.push({ label: c.name, value, status });
    }

    const blocks: Block[] = [
      kv(
        [
          { label: "Page", value: base.finalUrl, status: "info" },
          { label: "Browser baseline", value: `HTTP ${base.status}, ${base.words} words, ${base.bytes.toLocaleString("en")} bytes`, status: base.status < 400 ? "pass" : "fail" },
          {
            label: "robots.txt",
            value:
              robots.state === "fetched"
                ? `found (${robots.parsed.groups.length} groups)`
                : robots.state === "missing"
                  ? "not found, so every crawler is allowed"
                  : `could not be read (${robots.status ?? robots.error ?? "no answer"}), so well-behaved crawlers stay out`,
            status: robots.state === "unreachable" ? "fail" : "info",
          },
          {
            label: "JavaScript dependence",
            value:
              base.jsDependent === "yes"
                ? "the main content is not in the HTML; crawlers that do not run JavaScript see an empty page"
                : base.jsDependent === "likely"
                  ? "thin HTML with an app shell; crawlers that do not run JavaScript may miss the main content"
                  : "the main content is in the HTML",
            status: base.jsDependent === "yes" ? "fail" : base.jsDependent === "likely" ? "warn" : "pass",
          },
          { label: "Blocked by robots.txt", value: `${blockedByRobots} of ${CRAWLERS.length}`, status: blockedByRobots ? "warn" : "pass" },
          { label: "Blocked by the server", value: `${blockedByServer} of ${fetchable.length}`, status: blockedByServer ? "fail" : "pass" },
        ],
        "Summary",
      ),
      kv(summary, "Per crawler"),
      table(
        ["Crawler", "Operator", "robots.txt", "HTTP", "Bytes", "Title", "Words (raw HTML)", "Needs JS", "Difference from a browser"],
        rows,
        "Details",
      ),
    ];

    if (flags.length) blocks.push(list(flags, "Crawlers treated differently from a browser"));

    if (robots.state === "fetched" && EXTRA_ROBOTS_TOKENS.length) {
      blocks.push(
        table(
          ["Token", "robots.txt"],
          EXTRA_ROBOTS_TOKENS.map((t) => [t, robotsVerdictFor(robots, t, url).summary]),
          "Other AI tokens in robots.txt",
        ),
      );
    }

    blocks.push(
      text(
        "Each crawler's user agent was sent from our servers, not from the operator's network. Sites that verify crawlers by IP address " +
          "may block these requests while letting the real crawler in, so a server block here is worth confirming in your firewall or CDN logs. " +
          "Word counts are from the raw HTML with no JavaScript run, which is what most AI crawlers read. " +
          "Google-Extended is not a crawler: Google fetches with Googlebot, and Google-Extended only controls whether that content may be used for Gemini.",
        "How to read this",
      ),
    );
    return blocks;
  },
});
