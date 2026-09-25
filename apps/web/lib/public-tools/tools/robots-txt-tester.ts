// ---------------------------------------------------------------------------
// robots.txt tester: may this crawler fetch this URL, and which line says so
// ---------------------------------------------------------------------------

import { z } from "zod";
import { defineTool } from "../types";
import { publicUrl } from "../url";
import { code, kv, list, table, type Block } from "../blocks";
import { ToolError } from "../errors";
import { UnsafeUrlError } from "../safe-fetch";
import { describeRule, loadRobotsTxt, productToken, robotsTarget, robotsVerdictFor, ROBOTS_MAX_BYTES } from "../robots";

export const DEFAULT_AGENTS = [
  "Googlebot",
  "Bingbot",
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "*",
];

const SHOWN_CHARS = 30_000;

const input = z.object({
  url: publicUrl,
  userAgent: z
    .string()
    .trim()
    .max(300, "That user agent is too long.")
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export const robotsTxtTester = defineTool({
  slug: "robots-txt-tester",
  kind: "fetch",
  input,
  perIpLimit: { limit: 30, windowMs: 60 * 60 * 1000 },
  estimateCents: 0,
  async run({ url, userAgent }, ctx) {
    let load;
    try {
      load = await loadRobotsTxt(url, ctx.fetch, { signal: ctx.signal });
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw new ToolError("invalid_input", err.message);
      throw err;
    }
    const target = robotsTarget(url);
    const agents = userAgent ? [productToken(userAgent, DEFAULT_AGENTS)] : DEFAULT_AGENTS;

    const rows = agents.map((agent) => {
      const v = robotsVerdictFor(load, agent === "*" ? "*" : agent, url);
      return [
        agent === "*" ? "* (any other crawler)" : agent,
        v.allowed ? "allowed" : "blocked",
        load.state === "fetched" ? describeRule(v.rule) : v.summary.replace(/^\w+: /, ""),
        load.state === "fetched" ? (v.group === null ? "none (no group, no * group)" : v.group) : null,
      ];
    });

    const stateText =
      load.state === "fetched"
        ? `found at ${load.finalUrl} (HTTP ${load.status})`
        : load.state === "missing"
          ? `not found (${load.status ? `HTTP ${load.status}` : load.error ?? "no file"}${load.error && load.status ? `, ${load.error}` : ""}): every URL is allowed`
          : `could not be read (${load.status ? `HTTP ${load.status}` : load.error ?? "no answer"}): well-behaved crawlers treat the whole site as off limits until it can be`;

    const blocks: Block[] = [
      kv(
        [
          { label: "robots.txt", value: stateText, status: load.state === "unreachable" ? "fail" : load.state === "missing" ? "info" : "pass" },
          { label: "Tested path", value: target, status: "info" },
          ...(userAgent ? [{ label: "User agent", value: `${userAgent} (matched as token "${agents[0]}")`, status: "info" as const }] : []),
          ...(load.state === "fetched"
            ? [
                { label: "Groups", value: String(load.parsed.groups.length), status: "info" as const },
                { label: "Sitemaps declared", value: String(load.parsed.sitemaps.length), status: load.parsed.sitemaps.length ? ("pass" as const) : ("info" as const) },
              ]
            : []),
          ...(load.truncated
            ? [{ label: "Size", value: `over ${ROBOTS_MAX_BYTES / 1024} KiB; crawlers may ignore everything after that`, status: "warn" as const }]
            : []),
        ],
        "robots.txt",
      ),
      table(["Crawler", "Verdict", "Deciding rule", "Group applied"], rows, `Can crawlers fetch ${target}?`),
    ];

    if (load.state === "fetched") {
      if (load.parsed.sitemaps.length) blocks.push(list(load.parsed.sitemaps.slice(0, 50), "Sitemap lines"));
      if (load.parsed.unknownLines.length) {
        blocks.push(
          list(
            load.parsed.unknownLines.slice(0, 20).map((l) => `Line ${l.line}: ${l.text}`),
            "Lines crawlers will ignore",
          ),
        );
      }
      const shown = load.body.length > SHOWN_CHARS ? `${load.body.slice(0, SHOWN_CHARS)}\n# … truncated for display` : load.body;
      blocks.push(code(shown || "(empty file)", "robots", "The file"));
    }
    return blocks;
  },
});
