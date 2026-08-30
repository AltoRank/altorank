#!/usr/bin/env tsx
/**
 * altorank readiness <domain>
 *
 * Chains the three audit modules into the concierge workflow:
 *   fetch -> check -> generate the missing artifacts -> report what to do
 *
 * Scope, stated honestly
 * ----------------------
 * This does NOT publish. The CMS adapters in lib/cms publish *articles* against
 * a configured workspace with stored credentials; site-wide plumbing (homepage
 * JSON-LD, robots.txt, llms.txt at the root) is a per-platform theme or plugin
 * concern that varies by CMS and often has no API at all.
 *
 * So v1 does the two things it can do honestly: it generates the exact artifact
 * and it says precisely where the artifact goes. An agency does not care whether
 * a fix arrived over an API or as a ten-minute paste with instructions; they
 * care that someone produced the right fix for all fifteen clients and proved it
 * worked afterwards. Pretending to auto-publish what we cannot write would be
 * the same class of claim as the fabricated traction this repo keeps scrubbing.
 *
 * Usage
 * -----
 *   npm run readiness -- example.com
 *   npm run readiness -- example.com --out ./tmp/readiness
 *   npm run readiness -- example.com --json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runAgentReadiness,
  type ReadinessCheckId,
  type ReadinessFinding,
  type ReadinessResult,
} from "../lib/audit/agent-readiness";
import { proposeSchema, renderJsonLd, type ProposalSet } from "../lib/audit/schema-generator";
import { htmlToMarkdown, buildLlmsTxt, type MarkdownResult } from "../lib/audit/markdown";

const UA =
  "Mozilla/5.0 (compatible; AltoRank-AgentReadiness/1.0; " +
  "+https://altorank.co; site readiness audit)";

interface Artifact {
  /** Path written on disk, relative to the run directory. */
  file: string;
  /** Where this belongs on the client's site. */
  placement: string;
  /** Why it is needed, tied back to a failing check. */
  reason: string;
}

function fixInstruction(check: string): string | null {
  switch (check) {
    case "entity_schema":
    case "structured_data":
      return "Paste into the <head> of the homepage. On WordPress this is the theme header or an SEO plugin's schema box; on Shopify it is theme.liquid.";
    case "machine_readable":
      return "Serve at https://<domain>/llms.txt as text/plain. Static file, no build step needed.";
    case "ai_crawlers_allowed":
      return "Edit robots.txt: remove the Disallow rules blocking the listed AI crawlers, or scope them to paths that genuinely should not be indexed.";
    case "content_signals":
      return "Add a Content-Signal line to robots.txt declaring ai-train / search / ai-input preferences.";
    case "sitemap":
      return "Add a `Sitemap:` line to robots.txt pointing at the sitemap, and confirm the sitemap itself returns 200.";
    case "robots_reachable":
      return "Publish a robots.txt at the site root. Without one, crawlers get no guidance at all.";
    default:
      return null;
  }
}

function scoreLabel(score: number): string {
  if (score >= 85) return "good";
  if (score >= 70) return "workable";
  if (score >= 50) return "weak";
  return "poor";
}

async function fetchPage(url: string): Promise<{ status: number; html: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA },
      redirect: "follow",
    });
    return { status: res.status, html: await res.text() };
  } catch {
    return { status: 0, html: "" };
  } finally {
    clearTimeout(timeout);
  }
}

function renderReport(
  domain: string,
  readiness: ReadinessResult,
  proposals: ProposalSet,
  md: MarkdownResult,
  artifacts: Artifact[],
): string {
  const blocking = readiness.findings.filter((f) => !f.passed && f.severity !== "low");
  const minor = readiness.findings.filter((f) => !f.passed && f.severity === "low");
  const passed = readiness.findings.filter((f) => f.passed);

  const out: string[] = [
    `# Agent readiness: ${domain}`,
    "",
    `**Score ${readiness.score}/100** (${scoreLabel(readiness.score)}), ` +
      `${passed.length} of ${readiness.findings.length} checks passed.`,
    "",
  ];

  const line = (f: ReadinessFinding) => `- **${f.check}** (${f.severity}): ${f.detail}`;

  if (blocking.length) {
    out.push("## Blocking", "", ...blocking.map(line), "");
  }
  if (minor.length) {
    out.push("## Minor", "", ...minor.map(line), "");
  }
  out.push("## Already in place", "", ...passed.map(line), "");

  if (artifacts.length) {
    out.push("## Generated artifacts", "");
    for (const a of artifacts) {
      out.push(`### \`${a.file}\``, "", a.reason, "", `**Where it goes:** ${a.placement}`, "");
    }
  }

  // Proposals carry per-field provenance; surfacing it is what makes the
  // output reviewable rather than something to take on trust.
  for (const p of proposals.proposals) {
    if (!p.provenance.length) continue;
    out.push(`## ${p.type}: where each field came from`, "");
    for (const pv of p.provenance) {
      const value = typeof pv.value === "string" ? pv.value : JSON.stringify(pv.value);
      out.push(`- \`${pv.field}\` = ${value.slice(0, 90)}  _(${pv.source}, ${pv.confidence})_`);
    }
    if (p.missing.length) {
      out.push("", `**Needs a human:** ${p.missing.join(", ")}. Not guessed.`);
    }
    for (const w of p.warnings) out.push("", `⚠️ ${w}`);
    out.push("");
  }
  if (proposals.notes.length) {
    out.push("## Notes", "", ...proposals.notes.map((n) => `- ${n}`), "");
  }

  out.push(
    "## Content extraction",
    "",
    `Markdown twin built from \`${md.source}\`${md.heuristic ? " (heuristic, no semantic landmark on the page)" : ""}, ${md.words} words.`,
    "",
    "---",
    "",
    "Checks follow the stable tier of Cloudflare's agent-readiness guidance.",
    "Read from public site configuration only: robots.txt, sitemap, homepage.",
    "",
    "This tool generates artifacts and says where they go. It does not publish to the site.",
  );
  return out.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const domain = args.find((a) => !a.startsWith("--"));
  if (!domain) {
    console.error("usage: npm run readiness -- <domain> [--out DIR] [--json]");
    process.exit(1);
  }
  const outFlag = args.indexOf("--out");
  const outRoot = outFlag !== -1 ? args[outFlag + 1] : "./readiness-runs";
  const asJson = args.includes("--json");

  const clean = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const url = `https://${clean}/`;

  // 1. check
  const readiness = await runAgentReadiness(clean);
  if (readiness.error) {
    console.error(`${clean}: ${readiness.error}`);
    process.exit(2);
  }

  // 2. fetch once more for the generators (the checker does not return HTML)
  const page = await fetchPage(url);
  if (!page.html) {
    console.error(`${clean}: homepage fetch failed after checks passed; aborting`);
    process.exit(2);
  }

  // 3. generate
  const proposals = proposeSchema(page.html, url);
  const md = htmlToMarkdown(page.html, url);

  const runDir = join(outRoot, clean);
  await mkdir(join(runDir, "schema"), { recursive: true });
  const artifacts: Artifact[] = [];

  const failed = new Set(readiness.findings.filter((f) => !f.passed).map((f) => f.check));

  for (const p of proposals.proposals) {
    const file = join("schema", `${p.type.toLowerCase()}.html`);
    await writeFile(join(runDir, file), renderJsonLd(p) + "\n", "utf8");
    artifacts.push({
      file,
      placement: fixInstruction(p.type === "Organization" ? "entity_schema" : "structured_data")!,
      reason:
        p.type === "Organization"
          ? "The site has no Organization schema, so an assistant cannot resolve who it belongs to and will not name it."
          : `Adds ${p.type} markup built from content already on the page.`,
    });
  }

  if (md.markdown) {
    await writeFile(join(runDir, "index.md"), md.markdown, "utf8");
    if (failed.has("machine_readable")) {
      const llms = buildLlmsTxt({
        siteName: proposals.proposals.find((p) => p.type === "Organization")?.jsonLd.name as string
          ?? md.title
          ?? clean,
        summary: "Machine-readable index generated by AltoRank from pages found on the site.",
        pages: [{ url, title: md.title ?? "Home", section: "Start here" }],
      });
      await writeFile(join(runDir, "llms.txt"), llms, "utf8");
      artifacts.push({
        file: "llms.txt",
        placement: fixInstruction("machine_readable")!,
        reason:
          "The site offers no machine-readable version of its content. This is a starting index built from the homepage; extend it once a full crawl is run.",
      });
    }
  }

  // 4. instructions for the checks no artifact can fix
  const INSTRUCTION_ONLY: ReadinessCheckId[] = [
    "ai_crawlers_allowed",
    "robots_reachable",
    "sitemap",
    "content_signals",
  ];
  for (const check of INSTRUCTION_ONLY) {
    if (!failed.has(check)) continue;
    const finding = readiness.findings.find((f) => f.check === check)!;
    artifacts.push({
      file: `(no artifact) ${check}`,
      placement: fixInstruction(check)!,
      reason: finding.detail,
    });
  }

  const report = renderReport(clean, readiness, proposals, md, artifacts);
  await writeFile(join(runDir, "report.md"), report, "utf8");
  await writeFile(
    join(runDir, "report.json"),
    JSON.stringify({ domain: clean, readiness, proposals, markdown: { ...md, markdown: undefined }, artifacts }, null, 2),
    "utf8",
  );

  if (asJson) {
    console.log(JSON.stringify({ domain: clean, score: readiness.score, artifacts }, null, 2));
  } else {
    console.log(report);
    console.log(`\nwritten to ${runDir}/`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
