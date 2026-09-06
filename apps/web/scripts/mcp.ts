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
 * Two groups of tools:
 *
 *   public     the readiness loop against any domain, no credentials
 *   account    the agent API (/api/agent/v1) when ALTORANK_API_KEY is set:
 *              workspaces, keywords, articles, drafts. Same envelope, same
 *              client the CLI uses (scripts/lib/agent-client.ts).
 *
 * Every result is the agent envelope from lib/agent/envelope.ts:
 * `{ ok, data, agent_guidance }` or `{ ok: false, error, agent_guidance }`.
 * The guidance is the part a bare JSON blob leaves the model to guess.
 *
 * Scope, honestly: this does NOT expose publishing, approval or deletion. The
 * CMS adapters need per-workspace credentials out of Supabase plus the
 * approval gate, and an agent-triggered publish that bypasses a human
 * approving it is precisely what the approval gate exists to prevent. The
 * mutations that are here (move/remove planned keywords, find-and-replace in
 * a draft, retry a publish a human already approved, pause/resume a site)
 * need a key with the "write" scope and mirror the routes one-to-one.
 * scripts/SKILL.md is the agent-facing statement of the same rules.
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
import { fail, ok, type AgentErrorCode, type Envelope } from "../lib/agent/envelope";
import { agentRequest } from "./lib/agent-client";

const UA =
  "Mozilla/5.0 (compatible; AltoRank-AgentReadiness/1.0; " +
  "+https://altorank.co; site readiness audit)";

const domainArg = {
  domain: z
    .string()
    .describe("Bare domain to inspect, e.g. example.com. No scheme, no path."),
};

const workspaceArg = {
  workspace_id: z.string().uuid().describe("Workspace id from altorank_whoami or altorank_list_workspaces."),
};

/** One JSON text block carrying an envelope; every tool returns machine-readable output. */
const asEnvelope = (envelope: Envelope) => ({
  content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
  ...(envelope.ok ? {} : { isError: true as const }),
});

const asResult = (payload: unknown, guidance: string) => asEnvelope(ok(payload, guidance));

const asError = (code: AgentErrorCode, message: string, guidance: string) =>
  asEnvelope(fail(code, message, guidance));

const UNREACHABLE_GUIDANCE =
  "The homepage did not answer over https. Confirm the domain is right and publicly reachable, then retry once; if it still fails, tell the human rather than guessing at the site.";

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

const server = new McpServer(
  { name: "altorank", version: "0.3.0" },
  {
    instructions:
      "AltoRank audits sites for AI-search readiness and writes SEO drafts into a human's review queue. " +
      "Read apps/web/scripts/SKILL.md before using the account tools: preflight with altorank_whoami, pick a " +
      "workspace, check readiness, then suggest keywords and generate a draft. Every result is an envelope " +
      "{ ok, data | error, agent_guidance }; read agent_guidance first. Nothing here publishes, approves or " +
      "deletes, and you must not try to; the mutation tools (reschedule/remove planned keywords, find-and-replace " +
      "in drafts, retry a failed publish, pause/resume) need a key with the write scope and propose before they write. " +
      "Account tools need ALTORANK_API_KEY (create one at /settings/api-keys).",
  },
);

// ---------------------------------------------------------------------------
// Public tools: any domain, no credentials
// ---------------------------------------------------------------------------

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
    if (result.error) return asError("upstream_error", `${domain}: ${result.error}`, UNREACHABLE_GUIDANCE);
    const failing = result.findings.filter((f) => !f.passed);
    return asResult(
      result,
      failing.length
        ? `Score ${result.score}/100, ${failing.length} failing. Run altorank_readiness_report for the fixes, and lead with the high-severity findings when you tell the human.`
        : `Score ${result.score}/100 with every check passing. Say so plainly; there is nothing to fix.`,
    );
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
    if (!page) return asError("upstream_error", `${domain}: homepage not reachable over https`, UNREACHABLE_GUIDANCE);
    const { proposals, notes, existingTypes } = proposeSchema(page.html, page.url);
    return asResult(
      {
        domain,
        existingTypes,
        notes,
        proposals,
        rendered: proposals.map((p) => ({ type: p.type, html: renderJsonLd(p) })),
      },
      proposals.length
        ? "Hand the human the `rendered` tags for the <head>. Fields under `missing` need their answer; never fill them in yourself."
        : "Nothing to add: the page already declares these types. Tell the human the schema is in place.",
    );
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
    if (!page) return asError("upstream_error", `${domain}: homepage not reachable over https`, UNREACHABLE_GUIDANCE);
    const md = htmlToMarkdown(page.html, page.url);
    const llmsTxt = buildLlmsTxt({
      siteName: md.title ?? domain,
      summary: "Machine-readable index generated by AltoRank from pages found on the site.",
      pages: [{ url: page.url, title: md.title ?? "Home", section: "Start here" }],
    });
    return asResult(
      {
        domain,
        extraction: { source: md.source, heuristic: md.heuristic, words: md.words },
        markdown: md.markdown,
        llmsTxt,
      },
      md.heuristic
        ? "The content boundary was guessed (heuristic: true); skim the markdown before trusting it. Serve llmsTxt at /llms.txt as text/plain."
        : "Serve llmsTxt at /llms.txt as text/plain. The markdown came from an explicit <main> or <article>, so it is trustworthy.",
    );
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
    if (report.error) return asError("upstream_error", `${domain}: ${report.error}`, UNREACHABLE_GUIDANCE);
    return asResult(
      report,
      report.artifacts.length
        ? `${report.artifacts.length} artifact(s) with placement instructions. You cannot change the site; give each to the human with its placement, high severity first.`
        : "No artifacts needed. Report the score and stop.",
    );
  },
);

// ---------------------------------------------------------------------------
// Account tools: /api/agent/v1 through the shared client. Need ALTORANK_API_KEY.
// ---------------------------------------------------------------------------

server.registerTool(
  "altorank_whoami",
  {
    title: "Who am I (account preflight)",
    description:
      "Which AltoRank account this key opens, its workspaces and this month's drafting quota. " +
      "Run first. Needs ALTORANK_API_KEY.",
    inputSchema: {},
  },
  async () => asEnvelope(await agentRequest("/auth/whoami")),
);

server.registerTool(
  "altorank_list_workspaces",
  {
    title: "List workspaces",
    description: "Every site in the account, with ids for the other tools.",
    inputSchema: {},
  },
  async () => asEnvelope(await agentRequest("/workspaces")),
);

server.registerTool(
  "altorank_get_workspace",
  {
    title: "Get workspace",
    description: "One site with integration status and a `_human` block for describing its setup to a person.",
    inputSchema: workspaceArg,
  },
  async ({ workspace_id }) => asEnvelope(await agentRequest(`/workspaces/${workspace_id}`)),
);

server.registerTool(
  "altorank_list_keywords",
  {
    title: "List keywords",
    description: "Tracked keywords for a workspace, each with allowed_mutations. Difficulty null means unmeasured.",
    inputSchema: {
      ...workspaceArg,
      status: z.string().optional().describe("new | planned | drafting | scheduled | shipped | error"),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async ({ workspace_id, status, limit }) =>
    asEnvelope(await agentRequest("/keywords", { query: { workspace_id, status, limit } })),
);

server.registerTool(
  "altorank_suggest_keywords",
  {
    title: "Suggest keywords",
    description:
      "Keyword candidates for a workspace, from seed phrases or from the site itself. Spends research " +
      "credits: ask the human before calling. Nothing is saved.",
    inputSchema: {
      ...workspaceArg,
      seeds: z.array(z.string().min(3)).max(5).optional().describe("Up to five phrases to expand."),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ workspace_id, seeds, limit }) =>
    asEnvelope(await agentRequest("/keywords/suggest", { method: "POST", body: { workspace_id, seeds, limit } })),
);

server.registerTool(
  "altorank_list_articles",
  {
    title: "List articles",
    description: "Articles for a workspace with status, editor_url and allowed_mutations.",
    inputSchema: {
      ...workspaceArg,
      status: z.string().optional().describe("draft | drafting | review | approved | scheduled | live | error | archived"),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ workspace_id, status, limit }) =>
    asEnvelope(await agentRequest("/articles", { query: { workspace_id, status, limit } })),
);

server.registerTool(
  "altorank_get_article",
  {
    title: "Get article",
    description: "One article and its latest generation job. This is how you poll a draft you started.",
    inputSchema: { article_id: z.string().uuid() },
  },
  async ({ article_id }) => asEnvelope(await agentRequest(`/articles/${article_id}`)),
);

server.registerTool(
  "altorank_get_article_content",
  {
    title: "Get article content",
    description: "The article body as markdown (default), html or tiptap JSON. Read-only.",
    inputSchema: { article_id: z.string().uuid(), format: z.enum(["markdown", "html", "tiptap"]).optional() },
  },
  async ({ article_id, format }) =>
    asEnvelope(await agentRequest(`/articles/${article_id}/content`, { query: { format } })),
);

server.registerTool(
  "altorank_generate_draft",
  {
    title: "Generate a draft",
    description:
      "Write an article draft into the human's review queue. Returns immediately with the article id; poll " +
      "altorank_get_article until status is review, then hand the human editor_url. Costs quota: agree the " +
      "keyword with the human first. Cannot publish.",
    inputSchema: {
      ...workspaceArg,
      keyword: z.string().min(2).max(200),
      title: z.string().min(2).max(200).optional(),
      article_id: z.string().uuid().optional().describe("Regenerate into this existing draft instead of creating a new one."),
      allow_overage: z.boolean().optional().describe("Only after the human agreed to pay overage."),
    },
  },
  async (input) => asEnvelope(await agentRequest("/articles/generate", { method: "POST", body: input })),
);

server.registerTool(
  "altorank_usage",
  {
    title: "Usage and quota",
    description: "This month's drafting quota and per-workspace article counts. limit null means unmetered.",
    inputSchema: {},
  },
  async () => asEnvelope(await agentRequest("/usage")),
);

// ---------------------------------------------------------------------------
// Search Console reads: stored rows, never a Google call. ok:false when the
// workspace has no connection, so "not connected" is never read as zero.
// ---------------------------------------------------------------------------

const daysArg = { days: z.number().int().min(7).max(90).optional().describe("Window in days, default 28.") };

server.registerTool(
  "altorank_gsc_performance",
  {
    title: "Search Console performance",
    description:
      "Clicks and impressions over the window vs the window before, daily series, top pages and queries in positions 4-15 " +
      "(opportunities). From the stored nightly sync. Returns ok:false when Search Console is not connected - that is no data, not zero.",
    inputSchema: { ...workspaceArg, ...daysArg },
  },
  async ({ workspace_id, days }) => asEnvelope(await agentRequest("/gsc/performance", { query: { workspace_id, days } })),
);

server.registerTool(
  "altorank_gsc_cannibalization",
  {
    title: "Search Console cannibalisation",
    description: "Queries where two or more of the site's pages compete, with the page Google prefers and a merge/differentiate suggestion per loser.",
    inputSchema: {
      ...workspaceArg,
      ...daysArg,
      min_impressions: z.number().int().min(1).optional().describe("Ignore queries below this many impressions; default 10."),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async ({ workspace_id, days, min_impressions, limit }) =>
    asEnvelope(await agentRequest("/gsc/cannibalization", { query: { workspace_id, days, min_impressions, limit } })),
);

server.registerTool(
  "altorank_gsc_coverage",
  {
    title: "Index coverage",
    description:
      "Every known page bucketed indexed / not_indexed / unknown from stored URL Inspection verdicts and search impressions. " +
      "\"unknown\" is a real bucket, not \"not indexed\".",
    inputSchema: { ...workspaceArg, ...daysArg, bucket: z.enum(["indexed", "not_indexed", "unknown"]).optional() },
  },
  async ({ workspace_id, days, bucket }) => asEnvelope(await agentRequest("/gsc/coverage", { query: { workspace_id, days, bucket } })),
);

server.registerTool(
  "altorank_gsc_url_inspection",
  {
    title: "URL inspection (stored)",
    description:
      "Google's last stored verdict for one URL on the site, plus whether it was served in search. Does not call Google; " +
      "a fresh inspection is the human's click in the editor.",
    inputSchema: { ...workspaceArg, url: z.string().url().describe("Full https URL of a page on this site."), ...daysArg },
  },
  async ({ workspace_id, url, days }) => asEnvelope(await agentRequest("/gsc/url-inspection", { query: { workspace_id, url, days } })),
);

// ---------------------------------------------------------------------------
// Mutations: need the "write" scope. Each mirrors one POST route.
// ---------------------------------------------------------------------------

server.registerTool(
  "altorank_export_keywords",
  {
    title: "Export keywords",
    description: "Every tracked keyword with volume, difficulty, cpc, status and planned_for as rows (JSON). Empty numbers are unmeasured, not 0.",
    inputSchema: { ...workspaceArg, status: z.string().optional() },
  },
  async ({ workspace_id, status }) => asEnvelope(await agentRequest("/keywords/export", { query: { workspace_id, status, format: "json" } })),
);

server.registerTool(
  "altorank_reschedule_keywords",
  {
    title: "Reschedule planned keywords",
    description:
      "Move planned (unwritten) keywords to other days: either items [{keyword_id, date}] or keyword_ids + shift_days. " +
      "Same write as dragging on the planner. Skips keywords that are not on the plan or already written, with the reason. Needs write scope.",
    inputSchema: {
      ...workspaceArg,
      items: z.array(z.object({ keyword_id: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).min(1).max(60).optional(),
      keyword_ids: z.array(z.string().uuid()).min(1).max(60).optional(),
      shift_days: z.number().int().min(-365).max(365).optional(),
    },
  },
  async (input) => asEnvelope(await agentRequest("/keywords/bulk-reschedule", { method: "POST", body: input })),
);

server.registerTool(
  "altorank_remove_keywords_from_plan",
  {
    title: "Remove keywords from the plan",
    description:
      "Take planned keywords off the calendar. The keywords stay tracked (marked excluded so the planner does not re-add them); " +
      "nothing is deleted. Same as the planner's Remove. Needs write scope.",
    inputSchema: { ...workspaceArg, keyword_ids: z.array(z.string().uuid()).min(1).max(60) },
  },
  async (input) => asEnvelope(await agentRequest("/keywords/bulk-remove", { method: "POST", body: input })),
);

const replaceArgs = {
  find: z.string().min(1).max(500),
  replace: z.string().max(2000),
  match_case: z.boolean().optional(),
  whole_word: z.boolean().optional(),
  preview_only: z.boolean().optional().describe("Default true: returns the proposal and changes nothing. Send false only after the human agreed."),
};

server.registerTool(
  "altorank_replace_in_article",
  {
    title: "Find and replace in a draft",
    description:
      "Find-and-replace in one draft's title and body. Preview by default (hits with before → after excerpts); preview_only:false writes. " +
      "Never changes status: refused on approved, scheduled or live articles. Needs write scope.",
    inputSchema: { article_id: z.string().uuid(), ...replaceArgs },
  },
  async ({ article_id, ...body }) => asEnvelope(await agentRequest(`/articles/${article_id}/replace`, { method: "POST", body })),
);

server.registerTool(
  "altorank_bulk_replace_in_articles",
  {
    title: "Find and replace across drafts",
    description:
      "The same find-and-replace across up to 10 editable drafts in a workspace (or the given article_ids). Preview by default. " +
      "Approved, scheduled and live articles are skipped with the reason. Needs write scope.",
    inputSchema: { ...workspaceArg, article_ids: z.array(z.string().uuid()).min(1).max(10).optional(), ...replaceArgs },
  },
  async (input) => asEnvelope(await agentRequest("/articles/bulk-replace", { method: "POST", body: input })),
);

server.registerTool(
  "altorank_retry_publish",
  {
    title: "Retry a failed publish",
    description:
      "Re-run the last FAILED publish of an article a human already approved, through the same connection. Refused unless the last " +
      "attempt failed and the article is still approved; this is not a publish call and cannot publish a draft. Needs write scope.",
    inputSchema: { article_id: z.string().uuid() },
  },
  async ({ article_id }) => asEnvelope(await agentRequest(`/articles/${article_id}/retry-publish`, { method: "POST" })),
);

server.registerTool(
  "altorank_pause_workspace",
  {
    title: "Pause a site",
    description: "Stop drafting and publishing for one site until resumed. Drafts, plan and pace are untouched. Needs write scope.",
    inputSchema: workspaceArg,
  },
  async ({ workspace_id }) => asEnvelope(await agentRequest(`/workspaces/${workspace_id}/pause`, { method: "POST" })),
);

server.registerTool(
  "altorank_resume_workspace",
  {
    title: "Resume a site",
    description: "Put a hand-paused site back and re-plan its calendar from today. Cannot lift the account-wide billing pause. Needs write scope.",
    inputSchema: workspaceArg,
  },
  async ({ workspace_id }) => asEnvelope(await agentRequest(`/workspaces/${workspace_id}/resume`, { method: "POST" })),
);

// No top-level await: apps/web is CJS (no "type": "module"), and tsx compiles
// .ts here to the cjs output format, which rejects it.
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `altorank mcp server ready (stdio); account tools ${process.env.ALTORANK_API_KEY ? "armed" : "need ALTORANK_API_KEY"}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
