#!/usr/bin/env tsx
/**
 * Run the first-look analysis for a domain, and say what it cost.
 *
 *   npm run analyse -- --domain=fitsuite.co
 *   npm run analyse -- --domain=fitsuite.co --force
 *
 * SPENDS MONEY, and is the only script here that does more than a few cents
 * of it: ranked keywords, keyword discovery, a competitor gap, domain metrics
 * and backlinks are all DataForSEO Labs calls. Every one is reported as it
 * happens and totalled at the end, because a script that quietly spends is a
 * script nobody runs twice.
 *
 * What it is for. The site crawl scores a customer's pages against a keyword
 * inferred from the URL, because nothing knows better. This is what knows
 * better: `ranked_keywords` reports the terms the domain actually ranks for
 * AND the page that earns each one. Stored in `domain_audits`, which
 * lib/seo/site-crawl.ts already reads - so re-crawling afterwards replaces
 * 199 guesses with real keywords and real positions, and the refresh queue
 * (ranking 4-30, weakest citation readiness first) becomes answerable.
 *
 * Refuses a domain that has been analysed before unless --force, since the
 * whole point is that this one costs real money.
 */

import { createClient } from "@supabase/supabase-js";
import { analyseDomain } from "@/lib/audit/domain-analysis";
import { setSpendReporter, hasDataForSEOCredentials } from "@/lib/seo/client";
import { groupByPage, strikingDistance } from "@/lib/seo/ranked-keywords";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const DOMAIN = flag("domain");
const FORCE = args.includes("--force");

const heading = (s: string) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);

async function main(): Promise<void> {
  if (!DOMAIN) {
    console.error("--domain is required.");
    process.exit(1);
  }
  if (!url || !serviceKey) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(1);
  }
  if (!hasDataForSEOCredentials()) {
    console.error("No DataForSEO credentials: every paid layer would be skipped and this would do almost nothing.");
    process.exit(1);
  }

  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: ws } = await db
    .from("workspaces")
    .select("id, domain, language, first_analysed_at")
    .eq("domain", DOMAIN)
    .maybeSingle();
  if (!ws) {
    console.error(`No workspace for ${DOMAIN}.`);
    process.exit(1);
  }
  if (ws.first_analysed_at && !FORCE) {
    console.error(
      `${DOMAIN} was analysed on ${new Date(ws.first_analysed_at as string).toLocaleString()}.\n` +
        "Re-running spends again; pass --force if that is what you want.",
    );
    process.exit(1);
  }

  // Every DataForSEO call this run makes, as it happens.
  const spend: Array<{ operation: string; costUsd: number }> = [];
  setSpendReporter(({ operation, costUsd }) => {
    const cost = costUsd ?? 0;
    spend.push({ operation, costUsd: cost });
    console.log(`  $${cost.toFixed(5)}  ${operation}`);
  });

  heading(`Analysing ${DOMAIN}`);
  const t0 = Date.now();
  const analysis = await analyseDomain({
    domain: DOMAIN,
    supabase: db,
    workspaceId: ws.id as string,
    locale: (ws.language as string) ?? "en",
  });
  setSpendReporter(null);

  heading("Cost");
  const total = spend.reduce((a, b) => a + b.costUsd, 0);
  console.log(`  ${spend.length} calls, $${total.toFixed(4)} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  heading("What each layer returned");
  for (const l of analysis.layers) {
    console.log(`  ${l.status === "ok" ? "ok  " : l.status === "failed" ? "FAIL" : "--  "} ${pad(l.id, 18)} ${l.detail}`);
  }

  heading("The domain");
  console.log(`  authority ${analysis.authority ?? "—"}   organic traffic ${analysis.traffic?.toLocaleString() ?? "—"}/mo`);
  console.log(`  platform  ${analysis.platform ?? "—"}`);
  console.log(`  ${analysis.rankedKeywords.length} ranking keywords across ${groupByPage(analysis.rankedKeywords).size} pages`);

  const close = strikingDistance(analysis.rankedKeywords);
  if (close.length) {
    heading(`Striking distance: position 8-30, highest volume first (${close.length})`);
    console.log(pad("KEYWORD", 40), "POS   VOL  PAGE");
    for (const k of close.slice(0, 15)) {
      const path = k.url ? new URL(k.url, "https://x.invalid").pathname : "—";
      console.log(pad(k.keyword, 40), String(k.position).padStart(3), String(k.volume ?? 0).padStart(6), " " + pad(path, 40));
    }
  }

  console.log(`\n${analysis.headline}`);
  console.log(
    `\nNext: re-crawl so the pages pick up these keywords and positions.\n` +
      `  npm run crawl:site -- --domain=${DOMAIN} --only=/blog/ --max=250`,
  );
}

main().catch((err) => {
  setSpendReporter(null);
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
