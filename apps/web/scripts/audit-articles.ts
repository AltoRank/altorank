#!/usr/bin/env tsx
/**
 * Score every article already in the database, with the scorers as they are
 * today.
 *
 *   npm run audit:articles                 every workspace
 *   npm run audit:articles -- --domain=x   one site
 *   npm run audit:articles -- --json       machine-readable, for a diff
 *   npm run audit:articles -- --limit=20
 *
 * Read-only. No writes, no model call, no provider call: every number here is
 * a pure function of stored content, so running it costs nothing and can be
 * repeated after a scorer change to see what moved.
 *
 * It exists because the scores stored on an article are a snapshot from the
 * moment it was generated, under whatever the rules were that day. After the
 * September 2026 rebalance - density banded to 0.5-2%, title length scored,
 * word count measured against the SERP-derived target, links classified
 * against the site's own domain - the stored numbers are not comparable with
 * what the same draft would score now. This recomputes them all, side by side
 * with what is stored, and lists what a reviewer would have to fix.
 *
 * The gap between `stored` and `now` is the interesting column: a large drop
 * means the old score was flattering, which is the thing the rebalance was
 * for.
 */

import { createClient } from "@supabase/supabase-js";
import { tiptapToHtml } from "@/lib/cms/html";
import { scoreArticle } from "@/lib/seo/scoring";
import { scoreCitationReadiness } from "@/lib/seo/aeo-scoring";
import { auditArticle, GROUP_LABEL, type AuditItem } from "@/lib/seo/article-audit";
import { factCheckArticle, approvalBlocker } from "@/lib/ai/fact-check";
import type { ArticleResearch } from "@/lib/seo/research";
import type { LinkCheck } from "@/lib/seo/link-check";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const asJson = args.includes("--json");
const domainFilter = flag("domain");
const limit = Number(flag("limit") ?? 200);

interface Row {
  id: string;
  title: string;
  slug: string;
  keyword: string;
  status: string;
  domain: string;
  seoStored: number | null;
  seoNow: number;
  geoStored: number | null;
  geoNow: number;
  words: number;
  internal: number;
  external: number;
  dead: number;
  verdict: string;
  blocker: string | null;
  fails: AuditItem[];
  warns: AuditItem[];
}

function pad(s: string, n: number): string {
  const t = s.length > n ? `${s.slice(0, n - 1)}…` : s;
  return t.padEnd(n);
}

/** `72 → 61 (-11)`, or `— → 61` when nothing was stored. */
function delta(stored: number | null, now: number): string {
  if (stored === null) return `  — →${String(now).padStart(4)}`;
  const d = now - stored;
  const sign = d > 0 ? `+${d}` : String(d);
  return `${String(stored).padStart(3)} →${String(now).padStart(4)} (${sign.padStart(4)})`;
}

async function main(): Promise<void> {
  if (!url || !serviceKey) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(1);
  }

  // Service role: reads across every tenant, which is why this is a script and
  // not a route. Read-only by construction - nothing below writes.
  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: workspaces, error: wsError } = await db
    .from("workspaces")
    .select("id, domain, name");
  if (wsError) throw new Error(`workspaces: ${wsError.message}`);

  const byId = new Map(
    (workspaces ?? []).map((w) => [w.id as string, (w.domain as string) ?? ""]),
  );

  let query = db
    .from("articles")
    // One literal, deliberately not concatenated: supabase-js infers the row
    // type from this string, and a `+` between two halves erases it.
    .select("id, workspace_id, title, slug, keyword, status, content, meta_description, featured_image_url, seo_score, aeo_score, research, link_checks, updated_at")
    .not("content", "is", null)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (domainFilter) {
    const ids = (workspaces ?? [])
      .filter((w) => ((w.domain as string) ?? "").includes(domainFilter))
      .map((w) => w.id as string);
    if (ids.length === 0) {
      console.error(`No workspace matches "${domainFilter}".`);
      process.exit(1);
    }
    query = query.in("workspace_id", ids);
  }

  const { data: articles, error } = await query;
  if (error) throw new Error(`articles: ${error.message}`);
  if (!articles?.length) {
    console.log("No articles with content found.");
    return;
  }

  const rows: Row[] = [];

  for (const a of articles) {
    const domain = byId.get(a.workspace_id as string) ?? "";
    const html = tiptapToHtml(a.content as Record<string, unknown>);
    const keyword = (a.keyword as string) ?? "";
    const research = (a.research as ArticleResearch | null) ?? null;

    const seo = scoreArticle(html, keyword, {
      metaDescription: a.meta_description as string | null,
      siteDomain: domain,
      targetWordCount: research?.recommendedWordCount ?? null,
      title: a.title as string,
    });
    const geo = scoreCitationReadiness(html, keyword, { siteDomain: domain });
    const audit = auditArticle({
      html,
      keyword,
      siteDomain: domain,
      title: a.title as string,
      metaDescription: a.meta_description as string | null,
      slug: a.slug as string,
      featuredImageUrl: a.featured_image_url as string | null,
      linkChecks: a.link_checks as LinkCheck[] | null,
    });
    const fact = factCheckArticle(html, research ?? undefined);

    rows.push({
      id: a.id as string,
      title: (a.title as string) ?? "(untitled)",
      slug: (a.slug as string) ?? "",
      keyword,
      status: (a.status as string) ?? "",
      domain,
      seoStored: (a.seo_score as number | null) ?? null,
      seoNow: seo.score,
      geoStored: (a.aeo_score as number | null) ?? null,
      geoNow: geo.score,
      words: audit.items.length ? html.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length : 0,
      internal: audit.links.filter((l) => l.kind === "internal").length,
      external: audit.links.filter((l) => l.kind === "external").length,
      dead: audit.links.filter((l) => l.kind === "dead" || l.kind === "placeholder").length,
      verdict: audit.verdict,
      blocker: approvalBlocker(fact),
      fails: audit.items.filter((i) => i.status === "fail"),
      warns: audit.items.filter((i) => i.status === "warn"),
    });
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // --- Table ---------------------------------------------------------------
  console.log(
    `\n${rows.length} article${rows.length === 1 ? "" : "s"} with content` +
      (domainFilter ? ` on ${domainFilter}` : "") +
      ". SEO and GEO are stored → recomputed now.\n",
  );
  console.log(
    pad("ARTICLE", 40),
    pad("STATUS", 9),
    pad("SEO stored→now", 20),
    pad("GEO stored→now", 20),
    pad("LINKS i/e/dead", 15),
    "AUDIT",
  );
  console.log("-".repeat(125));
  for (const r of rows) {
    console.log(
      pad(r.title, 40),
      pad(r.status, 9),
      pad(delta(r.seoStored, r.seoNow), 20),
      pad(delta(r.geoStored, r.geoNow), 20),
      pad(`${r.internal}/${r.external}/${r.dead}`, 15),
      `${r.verdict}${r.blocker ? " · BLOCKED" : ""}`,
    );
  }

  // --- What is wrong, across the corpus ------------------------------------
  const tally = new Map<string, { n: number; group: string; label: string }>();
  for (const r of rows) {
    for (const item of [...r.fails, ...r.warns]) {
      const cur = tally.get(item.id) ?? { n: 0, group: item.group, label: item.label };
      cur.n++;
      tally.set(item.id, cur);
    }
  }
  console.log("\nMOST COMMON FINDINGS\n");
  for (const [, v] of [...tally.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) {
    const pct = Math.round((v.n / rows.length) * 100);
    console.log(`  ${String(v.n).padStart(3)}/${rows.length} (${String(pct).padStart(3)}%)  ${GROUP_LABEL[v.group as keyof typeof GROUP_LABEL]}: ${v.label}`);
  }

  // --- Aggregates ----------------------------------------------------------
  const avg = (ns: number[]) => (ns.length ? Math.round(ns.reduce((a, b) => a + b, 0) / ns.length) : 0);
  const drift = rows.filter((r) => r.seoStored !== null);
  console.log("\nSUMMARY\n");
  console.log(`  SEO  now ${avg(rows.map((r) => r.seoNow))} avg` +
    (drift.length ? `, was ${avg(drift.map((r) => r.seoStored!))} stored (${rows.length - drift.length} never scored)` : ""));
  console.log(`  GEO  now ${avg(rows.map((r) => r.geoNow))} avg`);
  console.log(`  Links: ${rows.filter((r) => r.internal === 0).length} with no internal link, ` +
    `${rows.filter((r) => r.external === 0).length} with no source, ` +
    `${rows.filter((r) => r.dead > 0).length} with a dead or unresolved link`);
  console.log(`  Approval: ${rows.filter((r) => r.blocker).length} would be refused for unsourced figures`);
  console.log(`  Verdicts: ${["needs-work", "review", "ready"].map((v) => `${rows.filter((r) => r.verdict === v).length} ${v}`).join(", ")}`);

  // --- The worst offenders, in detail --------------------------------------
  const worst = [...rows].sort((a, b) => a.seoNow + a.geoNow - (b.seoNow + b.geoNow)).slice(0, 5);
  console.log("\nWORST FIVE, IN DETAIL\n");
  for (const r of worst) {
    console.log(`  ${r.title}`);
    console.log(`    /${r.slug}  keyword "${r.keyword}"  SEO ${r.seoNow}  GEO ${r.geoNow}  ${r.domain}`);
    if (r.blocker) console.log(`    BLOCKED: ${r.blocker}`);
    for (const f of r.fails) console.log(`    ! ${f.label}: ${f.detail}`);
    console.log();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
