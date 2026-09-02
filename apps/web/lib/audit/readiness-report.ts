import {
  runAgentReadiness,
  type ReadinessCheckId,
  type ReadinessResult,
} from "./agent-readiness";
import { proposeSchema, renderJsonLd, type SchemaProposal } from "./schema-generator";
import { htmlToMarkdown, buildLlmsTxt } from "./markdown";
import { fetchLenient, isTlsChainError } from "./lenient-fetch";

/**
 * Agent-readiness report for an arbitrary domain: check, then generate the
 * artifacts that fix what failed.
 *
 * Lives in lib/ rather than in the server action because it now has three
 * consumers with three runtimes: the dashboard action (Next), the readiness CLI
 * (tsx), and the MCP server (tsx, driven by an agent). Only the action is
 * Next-specific; the composition is not. Imports are relative on purpose: tsx
 * does not resolve the @/ alias, and this module must run outside Next.
 *
 * Deliberately NOT workspace-scoped, unlike app/actions/audit.ts. The concierge motion
 * runs this against a *prospect's client* before there is any workspace, any
 * client record, or any relationship. Forcing it through a workspace would make
 * the one thing it is for, checking a stranger's site to open a conversation,
 * the one thing it cannot do.
 *
 * Nothing is persisted for the same reason: there is no workspace to attach a
 * row to, and storing scans of third-party sites keyed to nobody is a data
 * question nobody has asked for yet. Run it, read it, send it.
 */

export interface ReadinessArtifact {
  /** Filename a user would save this as. */
  name: string;
  /** The content itself, ready to copy. */
  body: string;
  /** Where it goes on the target site. */
  placement: string;
}

export interface ReadinessReport {
  domain: string;
  result: ReadinessResult;
  proposals: SchemaProposal[];
  notes: string[];
  artifacts: ReadinessArtifact[];
  /** Content boundary the markdown extraction used, so callers can judge it. */
  extraction?: { source: string; heuristic: boolean; words: number };
  error?: string;
}

const UA =
  "Mozilla/5.0 (compatible; AltoRank-AgentReadiness/1.0; " +
  "+https://altorank.co; site readiness audit)";

/** Placement instructions, keyed by the check the artifact fixes. */
const PLACEMENT: Record<string, string> = {
  entity_schema:
    "Paste into the <head> of the homepage. WordPress: the theme header or an SEO plugin's schema box. Shopify: theme.liquid.",
  structured_data:
    "Paste into the <head> of the page it describes.",
  machine_readable:
    "Serve at /llms.txt as text/plain. A static file, no build step.",
  ai_crawlers_allowed:
    "Edit robots.txt: remove the Disallow rules blocking the listed AI crawlers, or scope them to paths that genuinely should not be indexed.",
  content_signals:
    "Add a Content-Signal line to robots.txt declaring ai-train / search / ai-input preferences.",
  sitemap:
    "Add a `Sitemap:` line to robots.txt pointing at the sitemap, and confirm the sitemap returns 200.",
  robots_reachable:
    "Publish a robots.txt at the site root. Without one, crawlers get no guidance at all.",
};

export async function buildReadinessReport(rawDomain: string): Promise<ReadinessReport> {
  const domain = rawDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return {
      domain: rawDomain,
      result: { domain, findings: [], score: 0 },
      proposals: [],
      notes: [],
      artifacts: [],
      error: "That does not look like a domain. Try example.com.",
    };
  }

  const result = await runAgentReadiness(domain);
  if (result.error) {
    return { domain, result, proposals: [], notes: [], artifacts: [], error: result.error };
  }

  // The checker does not hand back HTML, so fetch once more for the generators.
  const url = `https://${domain}/`;
  let html = "";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": UA },
        redirect: "follow",
      });
      html = await res.text();
    } catch (err) {
      if (!isTlsChainError(err)) throw err;
      html = (await fetchLenient(url, { userAgent: UA, timeoutMs: 15_000 })).body;
    }
    clearTimeout(timeout);
  } catch {
    return {
      domain,
      result,
      proposals: [],
      notes: [],
      artifacts: [],
      error: "Checks ran, but the homepage could not be fetched for artifact generation.",
    };
  }

  const { proposals, notes } = proposeSchema(html, url);
  const md = htmlToMarkdown(html, url);
  const failed = new Set(result.findings.filter((f) => !f.passed).map((f) => f.check));

  const artifacts: ReadinessArtifact[] = proposals.map((p) => ({
    name: `${p.type.toLowerCase()}.html`,
    body: renderJsonLd(p),
    placement: PLACEMENT[p.type === "Organization" ? "entity_schema" : "structured_data"],
  }));

  if (failed.has("machine_readable") && md.markdown) {
    const orgName = proposals.find((p) => p.type === "Organization")?.jsonLd.name;
    artifacts.push({
      name: "llms.txt",
      body: buildLlmsTxt({
        siteName: typeof orgName === "string" ? orgName : (md.title ?? domain),
        summary: "Machine-readable index generated by AltoRank from pages found on the site.",
        pages: [{ url, title: md.title ?? "Home", section: "Start here" }],
      }),
      placement: PLACEMENT.machine_readable,
    });
  }

  // Checks no artifact can fix: hand over the instruction instead.
  const INSTRUCTION_ONLY: ReadinessCheckId[] = [
    "ai_crawlers_allowed",
    "robots_reachable",
    "sitemap",
    "content_signals",
  ];
  for (const check of INSTRUCTION_ONLY) {
    if (!failed.has(check)) continue;
    const finding = result.findings.find((f) => f.check === check);
    artifacts.push({
      name: check,
      body: "",
      placement: `${finding?.detail ?? ""} ${PLACEMENT[check]}`.trim(),
    });
  }

  return {
    domain,
    result,
    proposals,
    notes,
    artifacts,
    extraction: { source: md.source, heuristic: md.heuristic, words: md.words },
  };
}
