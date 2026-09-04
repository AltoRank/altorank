#!/usr/bin/env tsx
/**
 * Generate one article end to end against a real site, and report every
 * signal the pipeline produced.
 *
 *   npm run test:article -- --domain=fitsuite.co --keyword="software personal trainer"
 *   npm run test:article -- --domain=fitsuite.co --dry
 *
 * This is the check unit tests cannot make. The internal-link resolver, the
 * outbound link verification, the rebalanced scores, the title budget and the
 * featured image on gpt-image-1-mini only prove themselves on a real run,
 * against a real SERP, with a real model. So: run it, then print what came
 * back beside what was expected.
 *
 * COSTS MONEY. One SERP call, one related-keywords call, one Anthropic
 * completion and one image: the price of a normal article, because it is one.
 * The row is real and lands in `review`; nothing publishes. `--dry` sets the
 * workspace up and stops before the model.
 *
 * Idempotent on account structure, like scripts/dogfood.ts: it finds the
 * agency and workspace or creates them, and never touches an existing article.
 */

import { createClient } from "@supabase/supabase-js";
import { generateArticle } from "@/lib/content/generate";
import { tiptapToHtml } from "@/lib/cms/html";
import { auditArticle } from "@/lib/seo/article-audit";
import { approvalBlocker, type FactCheckReport } from "@/lib/ai/fact-check";
import type { LinkCheck } from "@/lib/seo/link-check";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const flag = (n: string) =>
  args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const DOMAIN = flag("domain") ?? "fitsuite.co";
const KEYWORD = flag("keyword") ?? "software per personal trainer";
const LANG = flag("lang") ?? "it";
// 2380 is Italy, 2840 the United States. The SERP this is written against has
// to be the one the readers actually see.
const LOCATION = Number(flag("location") ?? (LANG === "it" ? 2380 : 2840));
const DRY = args.includes("--dry");

function heading(s: string) {
  console.log(`\n${s}\n${"-".repeat(s.length)}`);
}

async function main(): Promise<void> {
  if (!url || !serviceKey) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(1);
  }
  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  heading(`Workspace for ${DOMAIN}`);

  const { data: existingWs } = await db
    .from("workspaces")
    .select("id, agency_id, language, location_code")
    .eq("domain", DOMAIN)
    .maybeSingle();

  let workspaceId = existingWs?.id as string | undefined;

  if (workspaceId) {
    console.log(`  found workspace ${workspaceId} (lang ${existingWs?.language})`);
  } else {
    const { data: agency } = await db
      .from("agencies")
      .select("id")
      .eq("slug", "altorank")
      .maybeSingle();
    if (!agency) {
      console.error("  no 'altorank' agency. Run `npm run dogfood` first.");
      process.exit(1);
    }
    const { data, error } = await db
      .from("workspaces")
      .insert({
        agency_id: agency.id,
        name: DOMAIN,
        domain: DOMAIN,
        initials: DOMAIN.slice(0, 2).toUpperCase(),
        color: "emerald",
        status: "setup",
        language: LANG,
        location_code: LOCATION,
        ai_provider: "claude",
      })
      .select("id")
      .single();
    if (error) throw new Error(`workspace: ${error.message}`);
    workspaceId = data.id as string;
    console.log(`  created workspace ${workspaceId} (lang ${LANG}, location ${LOCATION})`);
  }

  // What the resolver can offer the writer. Zero is the expected answer today,
  // and the whole reason no generated article has an internal link: a target
  // is a live article with a published URL, and nothing is published.
  const { count: liveCount } = await db
    .from("articles")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "live")
    .not("published_url", "is", null);
  console.log(`  link targets available: ${liveCount ?? 0}`);
  console.log(`  keyword: "${KEYWORD}"`);

  if (DRY) {
    console.log("\n--dry: stopping before the model call. Nothing generated.");
    return;
  }

  heading("Generating");
  const t0 = Date.now();
  const result = await generateArticle({
    supabase: db,
    workspaceId: workspaceId!,
    keyword: KEYWORD,
    // Service role has no session. Saying so explicitly is the fix the cron
    // needed; letting getQuota resolve one returns "nobody" while still
    // counting as a session.
    callerEmail: null,
  });
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${result.tokensUsed.toLocaleString()} tokens`);

  const { data: article } = await db
    .from("articles")
    .select("id, title, slug, keyword, status, content, meta_description, featured_image_url, seo_score, aeo_score, word_count, research, fact_checks, link_checks")
    .eq("id", result.articleId)
    .single();
  if (!article) throw new Error("article vanished after generation");

  const html = tiptapToHtml(article.content as Record<string, unknown>);
  const audit = auditArticle({
    html,
    keyword: KEYWORD,
    siteDomain: DOMAIN,
    title: article.title as string,
    metaDescription: article.meta_description as string | null,
    slug: article.slug as string,
    featuredImageUrl: article.featured_image_url as string | null,
    linkableArticles: liveCount ?? 0,
    linkChecks: article.link_checks as LinkCheck[] | null,
  });

  heading("The article");
  const title = article.title as string;
  const target = (article.research as { recommendedWordCount?: number } | null)?.recommendedWordCount;
  console.log(`  title    ${title}`);
  console.log(`  length   ${title.length} chars ${title.length <= 60 ? "(fits a result line)" : "(OVER 60, will be truncated)"}`);
  console.log(`  slug     /${article.slug}`);
  console.log(`  words    ${article.word_count}${target ? ` (target ${target})` : ""}`);
  console.log(`  meta     ${(article.meta_description as string | null)?.length ?? 0} chars`);
  console.log(`  scores   SEO ${article.seo_score}   GEO ${article.aeo_score}`);
  console.log(`  editor   ${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.altorank.co"}/content/${article.id}`);

  heading("Featured image");
  const img = article.featured_image_url as string | null;
  console.log(img ? `  ${img}` : "  NONE - the run log above says why");

  heading("Links");
  const kinds = (k: string) => audit.links.filter((l) => l.kind === k).length;
  console.log(`  internal ${kinds("internal")}   external ${kinds("external")}   dead ${kinds("dead")}   unresolved ${kinds("placeholder")}`);
  const checks = (article.link_checks as LinkCheck[] | null) ?? [];
  if (checks.length === 0) console.log("  no outbound link checks recorded");
  for (const c of checks) {
    console.log(`  ${c.ok ? "ok  " : c.removed ? "GONE" : "??  "} ${String(c.status ?? "-").padStart(3)}  ${c.url}${c.reason ? `  (${c.reason})` : ""}`);
  }

  heading("Fact check");
  const fact = article.fact_checks as FactCheckReport | null;
  console.log(`  ${fact?.verdict}: ${fact?.summary}`);
  const blocker = fact ? approvalBlocker(fact) : null;
  console.log(blocker ? `  APPROVAL REFUSED: ${blocker}` : "  approval would be allowed");

  heading(`Audit: ${audit.verdict} (${audit.counts.fail} fail, ${audit.counts.warn} warn)`);
  for (const i of audit.items.filter((x) => x.status === "fail")) console.log(`  ! ${i.label}: ${i.detail}`);
  for (const i of audit.items.filter((x) => x.status === "warn")) console.log(`  ~ ${i.label}: ${i.detail}`);

  console.log("\nThe draft is in review. Nothing was published.");
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
