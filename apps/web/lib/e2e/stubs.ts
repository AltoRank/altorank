// ---------------------------------------------------------------------------
// Fixtures for the end-to-end suite, behind one switch
// ---------------------------------------------------------------------------
//
// `E2E_STUBS=1` makes the four things onboarding buys from the outside world -
// a read of the site, a model's description of it, DataForSEO's keywords and a
// written article - come from the fixtures below instead. The specs in
// apps/web/e2e drive the real UI, the real server actions, the real pipeline
// and the real database; only the paid, slow, non-deterministic edges are
// replaced, at the same entry points the product already treats as fallible.
//
// Off by default and never set in any deployment. The switch is read at call
// time, so it cannot be baked into a build. Every stub is keyed by domain, so
// a spec can ask for the failure path (`unreadable.*`) without a second server.
//
// Nothing here is shown as a measurement the product did not make. The
// analysis stub writes keywords and nothing else: authority, traffic,
// pagespeed and readiness stay null, exactly as a run with no provider leaves
// them. The article stub goes through the real fact checker, so its verdict is
// earned rather than asserted.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessProfile, InferenceResult } from "@/lib/onboarding/business-profile";
import type { SiteText } from "@/lib/onboarding/site-text";
import type { SiteDiscovery } from "@/lib/onboarding/site-discovery";
import type { DomainAnalysis } from "@/lib/audit/domain-analysis";
import type { GenerateArticleOptions, GenerateArticleResult } from "@/lib/content/generate";
import type { ArticleResearch } from "@/lib/seo/research";
import { classifyIntent } from "@/lib/seo/intent";
import { htmlToTiptapJson } from "@/lib/ai/tiptap";
import { factCheckArticle } from "@/lib/ai/fact-check";

export function e2eStubsEnabled(): boolean {
  return process.env.E2E_STUBS === "1";
}

/** Domains starting with this read as a site nothing could be learned from. */
export const UNREADABLE_PREFIX = "unreadable.";

function isUnreadable(domain: string): boolean {
  return domain.replace(/^https?:\/\//, "").toLowerCase().startsWith(UNREADABLE_PREFIX);
}

// --- The site --------------------------------------------------------------

const SITE_TEXT = [
  "Nomad Atlas helps independent travellers plan slow journeys through Italy.",
  "We publish itineraries written by people who live in the places they describe, with the train times, the market days and the closing hours that guidebooks leave out.",
  "Every route on the site has been walked, cycled or ridden by one of our editors in the last two years, and we say when it was last checked.",
  "Small tour operators use Nomad Atlas to publish their own routes to travellers who want a plan they can trust.",
  "Travel bloggers who write in Italian use it to reach readers outside their own following.",
  "We do not sell hotel rooms and we do not take commissions on bookings, which is why our recommendations do not change when a hotel changes its rates.",
  "Read the itineraries, follow one, and tell us what has changed since we were there.",
].join(" ");

export const STUB_PROFILE: BusinessProfile = {
  name: "Nomad Atlas",
  language: "Italian",
  country: "Italy",
  description:
    "Nomad Atlas publishes slow-travel itineraries for Italy, written and re-checked by editors who live along the routes. It does not sell rooms or take booking commissions, and it says when each route was last verified.",
  audiences: ["Independent travel planners in Italy", "Small tour operators publishing their own routes", "Travel bloggers who publish in Italian"],
  competitors: ["tripcraft.example", "wanderly.example"],
};

export function stubReadSiteText(domain: string, maxChars = 12_000): SiteText {
  if (isUnreadable(domain)) return { text: "", source: "none", chars: 0 };
  return { text: SITE_TEXT.slice(0, maxChars), source: "static", chars: SITE_TEXT.length };
}

export function stubInferProfile(domain: string): InferenceResult {
  if (isUnreadable(domain)) return { profile: null, reason: "unreadable", source: "none" };
  return { profile: { ...STUB_PROFILE, audiences: [...STUB_PROFILE.audiences], competitors: [...STUB_PROFILE.competitors] }, reason: "ok", source: "static" };
}

export function stubDiscoverSite(domain: string): SiteDiscovery {
  if (isUnreadable(domain)) return { sitemapUrl: null, blogRootUrl: null, exampleArticleUrls: [], found: false };
  const origin = `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return {
    sitemapUrl: `${origin}/sitemap.xml`,
    blogRootUrl: `${origin}/blog/`,
    exampleArticleUrls: [`${origin}/blog/a-week-in-the-langhe-by-train`, `${origin}/blog/market-days-in-puglia`],
    found: true,
  };
}

// --- Keywords ----------------------------------------------------------------
//
// Eight terms that pass `assessKeywordQuality`, so the plan and the first draft
// have something to choose from. Volume and difficulty are the shape a
// DataForSEO row has; they are fixture values standing in for that response
// and appear nowhere outside a run with the switch on.

export const STUB_KEYWORDS: { term: string; volume: number; difficulty: number; intent: "info" | "commercial" }[] = [
  { term: "content calendar template", volume: 2400, difficulty: 28, intent: "info" },
  { term: "seo content strategy", volume: 1900, difficulty: 41, intent: "info" },
  { term: "keyword research tools", volume: 6600, difficulty: 55, intent: "commercial" },
  { term: "blog post checklist", volume: 720, difficulty: 18, intent: "info" },
  { term: "technical seo audit", volume: 1300, difficulty: 47, intent: "commercial" },
  { term: "internal linking strategy", volume: 880, difficulty: 24, intent: "info" },
  { term: "programmatic seo", volume: 2900, difficulty: 39, intent: "info" },
  { term: "ai search optimization", volume: 1600, difficulty: 33, intent: "info" },
];

export async function stubAnalyseDomain(options: {
  domain: string;
  supabase?: SupabaseClient;
  workspaceId?: string;
}): Promise<DomainAnalysis> {
  const domain = options.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const { supabase, workspaceId } = options;
  let keywordsFound = 0;

  if (!isUnreadable(domain)) {
    keywordsFound = STUB_KEYWORDS.length;
    if (supabase && workspaceId) {
      const { data: existing } = await supabase.from("keywords").select("term").eq("workspace_id", workspaceId);
      const seen = new Set((existing ?? []).map((k) => (k.term as string).toLowerCase()));
      const rows = STUB_KEYWORDS.filter((k) => !seen.has(k.term)).map((k) => ({
        workspace_id: workspaceId,
        term: k.term,
        volume: k.volume,
        difficulty: k.difficulty,
        intent: k.intent,
        status: "new",
        source: "ideas",
      }));
      if (rows.length) {
        const { error } = await supabase.from("keywords").insert(rows);
        if (error) throw new Error(`E2E_STUBS keywords: ${error.message}`);
      }
      await supabase.from("workspaces").update({ first_analysed_at: new Date().toISOString() }).eq("id", workspaceId);
    }
  }

  return {
    domain,
    readiness: null,
    topicalProfile: null,
    pagesCrawled: 0,
    auditScore: null,
    issues: [],
    pagespeed: {},
    keywordsFound,
    rankedKeywords: [],
    strikingDistance: [],
    authority: null,
    traffic: null,
    platform: null,
    layers: [
      { id: "crawl", status: "unavailable", detail: "E2E_STUBS: the site was not crawled" },
      {
        id: "keywords",
        status: keywordsFound ? "ok" : "unavailable",
        detail: keywordsFound ? `${keywordsFound} keywords from the e2e fixture` : "E2E_STUBS: unreadable fixture, no keywords",
      },
    ],
    headline: keywordsFound ? `${keywordsFound} fixture keywords stored. Nothing about this domain was measured.` : "Could not analyse this domain (e2e fixture).",
  };
}

// --- The article -------------------------------------------------------------

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A short draft. No figures, so the fact checker has nothing to flag. */
export function stubArticleHtml(keyword: string, title: string): string {
  const k = keyword.trim();
  return [
    `<h1>${title}</h1>`,
    `<p>A ${k} is easier to keep than to start. This guide covers the decisions that make it stick: what goes in, who owns it, and how often it is reviewed.</p>`,
    `<h2>What a ${k} is for</h2>`,
    `<p>The point is not the document. It is that everyone who publishes can see what is coming, what is late, and what has already been said, without asking.</p>`,
    `<h2>Start smaller than you think</h2>`,
    `<p>One column for the working title, one for the owner, one for the date. Add a column only when two people have asked for the same thing.</p>`,
    `<h2>Review it on a fixed day</h2>`,
    `<p>Pick a weekday and keep it. A ${k} that is reviewed when someone remembers is a list of good intentions with dates on it.</p>`,
    `<h2>What to do next</h2>`,
    `<p>Write down the next four topics you would publish if nothing else got in the way, then put a name and a date next to each one.</p>`,
  ].join("\n");
}

export async function stubGenerateArticle(options: GenerateArticleOptions): Promise<GenerateArticleResult> {
  const { supabase, workspaceId, keyword, autonomous, selection, onChunk, onResearch } = options;

  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id, domain, language, ai_provider")
    .eq("id", workspaceId)
    .single();
  if (wsError || !workspace) throw new Error("Workspace not found");

  const language = (workspace.language as string | null) ?? "en";
  const title = options.title || `${titleCase(keyword)}: A Practical Guide`;
  const html = stubArticleHtml(keyword, title);
  const wordCount = html.replace(/<[^>]+>/g, " ").trim().split(/\s+/).length;
  const slug = (options.title || keyword).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  const research: ArticleResearch = {
    keyword,
    language,
    intent: classifyIntent(keyword, language),
    competitors: [],
    peopleAlsoAsk: [],
    aiOverview: null,
    relatedKeywords: [],
    existingPerformance: null,
    adjacentQueries: [],
    recommendedWordCount: wordCount,
    wordCountBasis: "E2E_STUBS fixture; no SERP was read",
    layers: [],
  };
  onResearch?.(research);
  onChunk?.(html);

  const factCheck = factCheckArticle(html, research);
  const now = new Date().toISOString();

  let articleId = options.articleId ?? null;
  if (!articleId) {
    const { data: created, error } = await supabase
      .from("articles")
      .insert({
        workspace_id: workspaceId,
        title,
        slug,
        keyword,
        status: "drafting",
        ai_provider: workspace.ai_provider || "claude",
        generated_autonomously: autonomous ?? false,
      })
      .select("id")
      .single();
    if (error || !created) throw new Error(`E2E_STUBS article: ${error?.message}`);
    articleId = created.id as string;
  }

  const { data: job, error: jobError } = await supabase
    .from("generation_jobs")
    .insert({
      workspace_id: workspaceId,
      article_id: articleId,
      status: "running",
      ai_provider: workspace.ai_provider || "claude",
      prompt_config: { keyword, title, autonomous: autonomous ?? false, e2eStub: true },
      started_at: now,
    })
    .select("id")
    .single();
  if (jobError || !job) throw new Error(`E2E_STUBS job: ${jobError?.message}`);

  const { error: saveError } = await supabase
    .from("articles")
    .update({
      content: htmlToTiptapJson(html, { siteDomain: (workspace.domain as string | null) ?? undefined }),
      title,
      word_count: wordCount,
      research,
      fact_checks: factCheck,
      fact_check_verdict: factCheck.verdict,
      search_intent: research.intent.intent,
      selection_reasons: selection?.reasons ?? null,
      selection_score: selection?.score ?? null,
      keyword_difficulty: selection?.difficulty ?? null,
      volume: selection?.volume ?? null,
      // The gate the real generator enforces: a machine writes, a person ships.
      status: "review",
      updated_at: now,
    })
    .eq("id", articleId);
  if (saveError) throw new Error(`E2E_STUBS article save: ${saveError.message}`);

  await supabase
    .from("generation_jobs")
    .update({ status: "completed", tokens_used: 0, result: { wordCount, title }, completed_at: new Date().toISOString() })
    .eq("id", job.id);

  // The refresh engine (#73) widened the result with the processed body and
  // its scores; the fixture reports what it wrote and measured nothing.
  return {
    articleId,
    jobId: job.id as string,
    title,
    wordCount,
    tokensUsed: 0,
    research,
    factCheck,
    html,
    metaDescription: "",
    linkChecks: null,
    seoScore: 0,
    aeoScore: 0,
  };
}
