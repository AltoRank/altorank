#!/usr/bin/env tsx
/**
 * AltoRank MCP server, stdio.
 *
 *   npm run mcp                 # from apps/web
 *
 * Register in Claude Code:
 *   claude mcp add altorank -- npx tsx apps/web/scripts/mcp.ts
 *
 * This is the second half of the agent-first thesis. The readiness tooling
 * makes *client sites* readable by agents; this makes *AltoRank itself*
 * drivable by one. Surfer, Semrush, Outrank and Jasper are all human
 * dashboards; "point Claude at a roster and it audits and generates the fixes"
 * is the sentence none of them can write.
 *
 * Tools are namespaced `altorank_*` so they compose cleanly alongside
 * `openseo_*` in the same agent session, per the pivot plan.
 *
 * Scope, honestly: this exposes the readiness-remediation loop, which is the
 * MVP. It does NOT expose publishing. The CMS adapters need per-workspace
 * credentials out of Supabase plus the approval gate, and an agent-triggered
 * publish that bypasses a human approving it is precisely what the approval
 * gate exists to prevent. Publishing lands here only once it can go through
 * that gate, not around it.
 *
 * stdio discipline: stdout carries JSON-RPC frames and nothing else. Anything
 * written to stdout that is not a frame corrupts the session, so all logging
 * goes to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAgentReadiness } from "../lib/audit/agent-readiness";
import { proposeSchema, renderJsonLd } from "../lib/audit/schema-generator";
import { htmlToMarkdown, buildLlmsTxt } from "../lib/audit/markdown";
import { buildReadinessReport } from "../lib/audit/readiness-report";

const UA =
  "Mozilla/5.0 (compatible; AltoRank-AgentReadiness/1.0; " +
  "+https://altorank.co; site readiness audit)";

const domainArg = {
  domain: z
    .string()
    .describe("Bare domain to inspect, e.g. example.com. No scheme, no path."),
};

/** One JSON text block; every tool returns machine-readable output. */
const asResult = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});

const asError = (message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  isError: true,
});

async function fetchHomepage(domain: string): Promise<{ url: string; html: string } | null> {
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const url = `https://${clean}/`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA },
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return { url, html: await res.text() };
  } catch {
    return null;
  }
}

const server = new McpServer({ name: "altorank", version: "0.1.0" });

server.registerTool(
  "altorank_check_readiness",
  {
    title: "Check agent readiness",
    description:
      "Run the nine agent-readiness checks against a domain: AI-crawler rules in " +
      "robots.txt, sitemap, structured data, Organization schema, machine-readable " +
      "content (llms.txt / markdown), title+meta, single h1, content signals. " +
      "Returns a severity-weighted 0-100 score and a finding per check. Reads " +
      "public site configuration only. Use this first; the other tools generate " +
      "fixes for what this reports as failing.",
    inputSchema: domainArg,
  },
  async ({ domain }) => {
    const result = await runAgentReadiness(domain);
    if (result.error) return asError(`${domain}: ${result.error}`);
    return asResult(result);
  },
);

server.registerTool(
  "altorank_propose_schema",
  {
    title: "Propose JSON-LD schema",
    description:
      "Draft Organization / FAQPage / Product JSON-LD for a page, built only from " +
      "evidence found on the page itself. Every field carries provenance (source + " +
      "confidence); anything unsourceable is listed under `missing` for a human " +
      "rather than guessed, because these are structured claims about someone " +
      "else's business. Skips types the page already has (seen through @graph), " +
      "so proposals are additive, never duplicates. `rendered` holds each proposal " +
      "as a paste-ready <script> tag.",
    inputSchema: domainArg,
  },
  async ({ domain }) => {
    const page = await fetchHomepage(domain);
    if (!page) return asError(`${domain}: homepage not reachable over https`);
    const { proposals, notes, existingTypes } = proposeSchema(page.html, page.url);
    return asResult({
      domain,
      existingTypes,
      notes,
      proposals,
      rendered: proposals.map((p) => ({ type: p.type, html: renderJsonLd(p) })),
    });
  },
);

server.registerTool(
  "altorank_generate_machine_readable",
  {
    title: "Generate machine-readable content",
    description:
      "Convert a page to Markdown and build a starter llms.txt for the site. The " +
      "content boundary prefers <main>, then the longest <article>, then " +
      "body-minus-chrome, and the result says which strategy was used " +
      "(`source`, `heuristic`) so you can judge how much to trust it. The " +
      "llms.txt is built from pages actually found, never from a hand-written " +
      "list. Serve it at /llms.txt as text/plain.",
    inputSchema: domainArg,
  },
  async ({ domain }) => {
    const page = await fetchHomepage(domain);
    if (!page) return asError(`${domain}: homepage not reachable over https`);
    const md = htmlToMarkdown(page.html, page.url);
    const llmsTxt = buildLlmsTxt({
      siteName: md.title ?? domain,
      summary: "Machine-readable index generated by AltoRank from pages found on the site.",
      pages: [{ url: page.url, title: md.title ?? "Home", section: "Start here" }],
    });
    return asResult({
      domain,
      extraction: { source: md.source, heuristic: md.heuristic, words: md.words },
      markdown: md.markdown,
      llmsTxt,
    });
  },
);

server.registerTool(
  "altorank_readiness_report",
  {
    title: "Full readiness report",
    description:
      "The whole loop in one call: run the checks, generate every artifact the " +
      "failures need (JSON-LD, llms.txt), and attach a placement instruction to " +
      "each, including instruction-only entries for things no artifact can fix " +
      "(blocked crawlers, missing robots.txt). This is what the dashboard " +
      "/readiness page and the `npm run readiness` CLI produce; prefer it when " +
      "the goal is 'fix this site' rather than a single measurement.",
    inputSchema: domainArg,
  },
  async ({ domain }) => {
    const report = await buildReadinessReport(domain);
    if (report.error) return asError(`${domain}: ${report.error}`);
    return asResult(report);
  },
);

// No top-level await: apps/web is CJS (no "type": "module"), and tsx compiles
// .ts here to the cjs output format, which rejects it.
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("altorank mcp server ready (stdio)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
