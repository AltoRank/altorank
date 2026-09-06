// ---------------------------------------------------------------------------
// The "email me this result" body, rendered on the server
// ---------------------------------------------------------------------------
//
// Until 2026-09-06 the email gate posted the subject and a raw HTML body from
// the browser, and `captureToolLead` sent whatever arrived to whatever address
// arrived, from our verified domain, unauthenticated and unlimited. That is an
// open relay: anyone with the action's URL could phish from
// noreply@updates.altorank.co.
//
// The browser now sends only the tool slug and the result data it already
// holds. Each slug maps to one renderer here; the data is validated with a
// bounded schema and every string is escaped before it lands in HTML. A slug
// with no renderer sends nothing.

import { z } from "zod";

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

// Bounds: a keyword or a domain is short; a generated paragraph is a few
// hundred characters; lists come from our own generators, which never return
// more than a few dozen items. Anything larger is not a tool result.
const short = z.string().trim().min(1).max(200);
const long = z.string().trim().max(2000);
const count = z.number().int().min(0).max(1_000_000);

export const TOOL_RESULT_SCHEMAS = {
  "seo-health-checker": z.object({
    url: short,
    score: z.number().min(0).max(100),
    errors: count,
    warnings: count,
    passes: count,
  }),
  "content-brief-generator": z.object({
    keyword: short,
    title: short,
    metaDescription: long,
    wordCountTarget: count,
  }),
  "serp-analyzer": z.object({
    keyword: short,
    locale: short,
    resultsAnalyzed: count,
    avgWordCount: count.nullable().optional(),
    aiInsights: long.optional(),
  }),
  "keyword-cluster-mapper": z.object({
    seeds: z.array(short).min(1).max(20),
    totalKeywords: count,
    totalVolume: count,
    clusters: z
      .array(
        z.object({
          name: short,
          suggestedPageType: short,
          keywords: z.array(short).max(100),
        }),
      )
      .max(50),
  }),
  "meta-description-generator": z.object({
    keyword: short,
    variants: z.array(z.object({ style: short, charCount: count, text: long })).min(1).max(20),
  }),
  "keyword-gap-analyzer": z.object({
    yourDomain: short,
    competitors: z.array(short).min(1).max(10),
    totalGapsFound: count,
  }),
} as const;

export type ToolResultSlug = keyof typeof TOOL_RESULT_SCHEMAS;
export const TOOL_RESULT_SLUGS = Object.keys(TOOL_RESULT_SCHEMAS) as ToolResultSlug[];

type Ctx<S extends ToolResultSlug> = z.infer<(typeof TOOL_RESULT_SCHEMAS)[S]>;

export type RenderedToolEmail = { subject: string; html: string };

const h2 = (t: string) => `<h2 style="color:#1a1a1a;">${esc(t)}</h2>`;
const p = (t: string, extra = "") => `<p style="color:#666;${extra}">${esc(t)}</p>`;
const credit = (tool: string) =>
  `<p style="color:#999;font-size:13px;margin-top:16px;">Generated with AltoRank's free ${esc(tool)}.</p>`;

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)}K`;
  return String(vol);
}

const RENDERERS: { [S in ToolResultSlug]: (c: Ctx<S>) => RenderedToolEmail } = {
  "seo-health-checker": (c) => ({
    subject: `SEO Health Report: ${c.url}`,
    html:
      h2(`SEO Health Score: ${c.score}/100`) +
      p(c.url) +
      p(`${c.errors} errors, ${c.warnings} warnings, ${c.passes} checks passed.`) +
      credit("SEO Health Checker"),
  }),
  "content-brief-generator": (c) => ({
    subject: `Content Brief: ${c.keyword}`,
    html:
      h2(c.title) +
      p(c.metaDescription) +
      p(`Word count target: ${c.wordCountTarget.toLocaleString("en-US")}`) +
      credit("Content Brief Generator"),
  }),
  "serp-analyzer": (c) => ({
    subject: `SERP Analysis: ${c.keyword}`,
    html:
      h2(`SERP Analysis: ${c.keyword}`) +
      p(
        `Locale: ${c.locale} | ${c.resultsAnalyzed} results analyzed` +
          (c.avgWordCount ? ` | Avg. word count: ${c.avgWordCount}` : ""),
      ) +
      (c.aiInsights ? p(c.aiInsights, "margin-top:16px;") : "") +
      credit("SERP Analyzer"),
  }),
  "keyword-cluster-mapper": (c) => ({
    subject: `Keyword Clusters: ${c.seeds.join(", ")}`,
    html:
      h2("Keyword Clusters") +
      p(`Seeds: ${c.seeds.join(", ")}`) +
      p(`${c.clusters.length} clusters, ${c.totalKeywords} total keywords, ${formatVolume(c.totalVolume)} total volume.`) +
      c.clusters
        .map(
          (cl) =>
            `<p style="margin-top:12px;"><strong style="color:#1a1a1a;">${esc(cl.name)}</strong> <span style="color:#999;">(${esc(cl.suggestedPageType)})</span><br/><span style="color:#666;">${esc(cl.keywords.join(", "))}</span></p>`,
        )
        .join(""),
  }),
  "meta-description-generator": (c) => ({
    subject: `Meta Descriptions: ${c.keyword}`,
    html: c.variants
      .map(
        (v) =>
          `<p style="margin-bottom:16px;"><strong style="color:#1a1a1a;">${esc(v.style)}</strong> <span style="color:#999;">(${v.charCount} chars)</span><br/><span style="color:#666;">${esc(v.text)}</span></p>`,
      )
      .join(""),
  }),
  "keyword-gap-analyzer": (c) => ({
    subject: `Keyword Gap Analysis: ${c.yourDomain}`,
    html:
      h2("Keyword Gap Analysis") +
      p(`${c.yourDomain} vs ${c.competitors.join(", ")}`) +
      p(`${c.totalGapsFound} keyword gaps found.`) +
      credit("Keyword Gap Analyzer"),
  }),
};

export function isToolResultSlug(slug: string): slug is ToolResultSlug {
  return Object.prototype.hasOwnProperty.call(TOOL_RESULT_SCHEMAS, slug);
}

/**
 * Subject and body for a tool's result email, or null when the slug has no
 * renderer or the context is not that tool's result. Nothing from `context`
 * reaches the HTML unescaped; the subject is plain text and is escaped by the
 * layout where it is used as the title.
 */
export function renderToolResultEmail(slug: string, context: unknown): RenderedToolEmail | null {
  if (!isToolResultSlug(slug)) return null;
  const parsed = TOOL_RESULT_SCHEMAS[slug].safeParse(context);
  if (!parsed.success) return null;
  // The map is keyed by the same slug as the schema, so the parsed shape is
  // the renderer's input; TypeScript cannot follow that across the index.
  return (RENDERERS[slug] as (c: unknown) => RenderedToolEmail)(parsed.data);
}
