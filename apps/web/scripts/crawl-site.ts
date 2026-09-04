#!/usr/bin/env tsx
/**
 * Read a site's own published pages, score them, and store them.
 *
 *   npm run crawl:site -- --domain=fitsuite.co
 *   npm run crawl:site -- --domain=fitsuite.co --max=40 --dry
 *
 * Costs nothing: a sitemap and some HTML over plain HTTP, then scorers that
 * are pure functions. `--dry` discovers and scores without writing, which is
 * the honest way to look at a prospect's site before they are a customer.
 *
 * The output is deliberately the refresh queue rather than a page list: what
 * is worth fixing, ordered, with the reason. A list of 204 rows is a
 * scoreboard; the first ten of them ranked by opportunity is a week of work.
 */

import { createClient } from "@supabase/supabase-js";
import { discoverUrls, prioritise, crawlPage, syncSitePages, type SitePage } from "@/lib/seo/site-crawl";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const DOMAIN = flag("domain") ?? "fitsuite.co";
const MAX = Number(flag("max") ?? 200);
const ONLY = flag("only");
const DRY = args.includes("--dry");

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);
const heading = (s: string) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

function report(pages: SitePage[], discovered: number) {
  const ok = pages.filter((p) => p.status >= 200 && p.status < 400);
  const scored = ok.filter((p) => p.seo_score !== null);
  const byType = (t: string) => ok.filter((p) => p.page_type === t).length;

  heading("What was found");
  console.log(`  ${discovered} URLs in the sitemap, ${pages.length} fetched, ${ok.length} answered`);
  console.log(`  ${byType("article")} articles, ${byType("listing")} indexes, ${byType("page")} other pages`);
  console.log(`  (indexes and non-article pages are stored but not scored: an index has no`);
  console.log(`   term it is trying to win, and scoring one produced GEO 14 on /blog/de)`);
  const failed = pages.filter((p) => p.status === 0 || p.status >= 400);
  if (failed.length) {
    console.log(`  ${failed.length} did not:`);
    for (const f of failed.slice(0, 5)) console.log(`    ${f.error}  ${f.url}`);
  }

  if (scored.length === 0) {
    console.log("\nNothing could be scored: no page offered a keyword to score against.");
    return;
  }

  const avg = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) / ns.length);
  heading("How the writing scores");
  console.log(`  SEO  ${avg(scored.map((p) => p.seo_score!))} avg`);
  console.log(`  GEO  ${avg(scored.map((p) => p.aeo_score!))} avg`);
  console.log(`  ${scored.filter((p) => (p.internal_links ?? 0) === 0).length} pages link to nothing on the site`);
  console.log(`  ${scored.filter((p) => (p.external_links ?? 0) === 0).length} pages cite no source`);
  const guessed = scored.filter((p) => p.keyword_source !== "ranked").length;
  console.log(`  ${scored.length - guessed} keywords from the SERP, ${guessed} inferred from the URL`);
  if (guessed) {
    console.log(`  (keyword-placement checks are skipped on the ${guessed} inferred ones: an exact-phrase`);
    console.log(`   test against a keyword we made up is not a finding anyone can act on)`);
  }

  // The queue. Ranking but not winning, weakest citation readiness first: the
  // pages where a rewrite has somewhere to go.
  const close = scored
    .filter((p) => p.position !== null && p.position! >= 4 && p.position! <= 30)
    .sort((a, b) => (a.aeo_score ?? 0) - (b.aeo_score ?? 0));
  if (!close.length) {
    heading("Refresh queue");
    console.log("  Needs rank data: which page ranks where comes from the domain analysis,");
    console.log("  and this workspace has none stored yet. Run the analysis, then re-crawl.");
  }
  if (close.length) {
    heading(`Refresh queue: ranking 4-30, weakest citation readiness first (${close.length})`);
    console.log(pad("PAGE", 46), pad("KEYWORD", 26), "POS  SEO  GEO");
    for (const p of close.slice(0, 12)) {
      console.log(pad(p.path, 46), pad(p.keyword ?? "", 26),
        String(p.position).padStart(3), String(p.seo_score).padStart(4), String(p.aeo_score).padStart(4));
    }
  }

  heading("Weakest pages overall (10)");
  console.log(pad("PAGE", 46), pad("KEYWORD", 26), " SEO  GEO  WORDS");
  for (const p of [...scored].sort((a, b) => (a.seo_score! + a.aeo_score!) - (b.seo_score! + b.aeo_score!)).slice(0, 10)) {
    console.log(pad(p.path, 46), pad(p.keyword ?? "", 26),
      String(p.seo_score).padStart(4), String(p.aeo_score).padStart(4), String(p.word_count).padStart(6));
  }

  // What every page gets wrong is a template problem, not an editing problem.
  const tally = new Map<string, number>();
  for (const p of scored) {
    const items = (p.audit as { items?: Array<{ status: string; label: string }> } | null)?.items ?? [];
    for (const i of items) {
      if (i.status === "fail" || i.status === "warn") tally.set(i.label, (tally.get(i.label) ?? 0) + 1);
    }
  }
  heading("Most common findings across the site");
  for (const [label, n] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(4)}/${scored.length}  ${label}`);
  }
}

async function main(): Promise<void> {
  heading(`Crawling ${DOMAIN}`);

  if (DRY) {
    const all = await discoverUrls(DOMAIN);
    const urls = prioritise(ONLY ? all.filter((u) => u.includes(ONLY)) : all, MAX);
    console.log(`  ${all.length} discovered, fetching ${urls.length} (dry: nothing will be stored)`);
    const pages: SitePage[] = [];
    const queue = [...urls];
    let done = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const u = queue.shift()!;
          pages.push(await crawlPage(u, { domain: DOMAIN }));
          if (++done % 20 === 0) console.log(`  ...${done}/${urls.length}`);
        }
      }),
    );
    report(pages, all.length);
    return;
  }

  if (!url || !serviceKey) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or pass --dry).");
    process.exit(1);
  }
  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: ws } = await db.from("workspaces").select("id").eq("domain", DOMAIN).maybeSingle();
  if (!ws) {
    console.error(`  no workspace for ${DOMAIN}. Create one first, or pass --dry.`);
    process.exit(1);
  }

  const summary = await syncSitePages(db, ws.id as string, DOMAIN, {
    maxPages: MAX,
    only: ONLY,
    onProgress: (d, t) => { if (d % 20 === 0) console.log(`  ...${d}/${t}`); },
  });
  await db.from("workspaces").update({ last_pages_crawl_at: new Date().toISOString() }).eq("id", ws.id);
  report(summary.pages, summary.discovered);

  const { count } = await db
    .from("site_pages")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", ws.id as string)
    .not("keyword", "is", null)
    .gte("status", 200)
    .lt("status", 400);
  console.log(`\nStored. The link resolver can now offer ${count ?? 0} targets on this site.`);
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
