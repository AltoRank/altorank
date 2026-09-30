import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ArticleResearch } from "@/lib/seo/research";
import type { SiteFacts, ArticlePrompt } from "@/lib/ai/types";
import { extractArticleMeta } from "@/lib/ai/utils";

// The whole generation path on the draft a physiotherapy clinic's first
// article (2026-09-27) came back as: a 77-character title repeated as an
// <h1>, no figure, an association named as the regulator, internal links to
// blog posts, the homepage as the call to action, no FAQ, no reviewer, no
// disclaimer. Every paid call is mocked; the clinic is invented.

const DOMAIN = "acme-physio.example";
const O = `https://${DOMAIN}`;

vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: async () => ({ limit: null, used: 0, remaining: null, reason: "plan", plan: "agency" }),
}));
vi.mock("@/lib/billing/spend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/spend")>()),
  recordSpend: async () => undefined,
}));
vi.mock("@/lib/billing/default-spend", () => ({ spendClient: () => null }));

const RESEARCH: ArticleResearch = {
  keyword: "physiotherapy vs athletic therapy",
  language: "English",
  intent: { intent: "info", confidence: "high", signals: [], lexicon: true },
  competitors: [],
  peopleAlsoAsk: ["Is athletic therapy covered by insurance?", "Can an athletic therapist diagnose?", "Which is better for a sprain?"],
  aiOverview: null,
  relatedKeywords: [],
  existingPerformance: null,
  adjacentQueries: [],
  recommendedWordCount: 1200,
  wordCountBasis: "test",
  layers: [],
  sourceFigures: [],
};
vi.mock("@/lib/seo/research", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/research")>()),
  gatherArticleResearch: async () => structuredClone(RESEARCH),
}));
vi.mock("@/lib/ai/article-questions", () => ({
  selectArticleQuestions: async (q: string[]) => ({ status: "qualified", kept: q, decisions: [] }),
}));

const FACTS: SiteFacts = {
  pagesRead: 4,
  offerings: [
    { name: "Sports Physiotherapy", url: `${O}/services/sports-physiotherapy` },
    { name: "Athletic Therapy", url: `${O}/services/athletic-therapy` },
  ],
  work: [],
  headings: [],
  stated: [],
  about: null,
  people: [{ name: "Sam Lee", role: "Registered Physiotherapist", source: `${O}/team` }],
  pages: [],
  conversion: { url: "tel:+15550102030", check: "the phone number saved in the business profile" },
  notes: [],
};
vi.mock("@/lib/content/site-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content/site-facts")>()),
  loadSiteFacts: async () => ({ facts: structuredClone(FACTS), layer: { id: "site_facts", status: "ok", detail: "test" } }),
}));
vi.mock("@/lib/seo/link-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/link-resolver")>()),
  fetchLinkTargets: async () => [],
}));
vi.mock("@/lib/linking/targets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/linking/targets")>()),
  fetchKnownPages: async () => [],
}));
vi.mock("@/lib/seo/link-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/link-check")>()),
  verifyOutboundLinks: async (html: string) => ({ html, checks: [] }),
}));
vi.mock("@/lib/ai/video-embedder", () => ({ embedYouTubeVideos: async (html: string) => html }));

/** What the writer produced for the clinic, in shape. */
const MODEL_HTML =
  "<h1>Physiotherapy vs Athletic Therapy: Which One Is Right for Your Sports Injury?</h1>" +
  "<p>Physiotherapy vs athletic therapy is a choice between two regulated professions that both treat sports injuries, with different training.</p>" +
  "<h2>What does each one treat?</h2><p>The Northland Physiotherapy Association regulates physiotherapists across the province.</p>" +
  "<h2>How do you choose?</h2><p>Start with the injury and where you are in recovery.</p>" +
  "<meta-description>Physiotherapy vs athletic therapy: what each treats and how to choose.</meta-description>";

const prompts: ArticlePrompt[] = [];
vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: () => ({
    async *streamArticle(prompt: ArticlePrompt) {
      prompts.push(prompt);
      yield MODEL_HTML;
      const meta = extractArticleMeta(MODEL_HTML);
      return { html: meta.cleanHtml, title: meta.title, metaDescription: meta.metaDescription, wordCount: 60, tokensUsed: 10, inputTokens: 5, outputTokens: 5 };
    },
  }),
}));

import { generateArticle } from "../generate";

const saved: Record<string, unknown>[] = [];

function client() {
  const workspace = {
    id: "ws1", account_id: "acc1", domain: DOMAIN, ai_provider: null, ai_model: null, language: "en", brand_style: null,
    location_code: null, status: "active", paused_until: null,
    business_profile: { name: "Acme Physio", description: "Sports physiotherapy and athletic therapy.", conversionUrl: "tel:+1 555 010 2030" },
  };
  return {
    from: (table: string) => {
      if (table === "articles") {
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "a1" }, error: null }) }) }),
          update: (row: Record<string, unknown>) => {
            saved.push(row);
            return { eq: async () => ({ error: null }) };
          },
          delete: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === "generation_jobs") {
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "job1" }, error: null }) }) }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      const chain: Record<string, unknown> = {
        eq: () => chain,
        ilike: () => chain,
        limit: () => chain,
        single: async () => ({ data: table === "workspaces" ? workspace : null, error: null }),
        maybeSingle: async () => ({ data: table === "workspaces" ? workspace : null, error: null }),
      };
      return { select: () => chain, upsert: async () => ({ error: null }) };
    },
  } as never;
}

beforeEach(() => {
  saved.length = 0;
  prompts.length = 0;
});

describe("the clinic's first article, through the whole generation path", () => {
  it("comes out with trust signals, honest checks, its own links and a clean head", async () => {
    const result = await generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "physiotherapy vs athletic therapy", callerEmail: null });
    const row = saved.find((r) => "content" in r)!;
    const html = result.html;

    // 5. Title fits; the body carries no <h1>; the writer was asked for a FAQ.
    expect(result.title).toBe("Physiotherapy vs Athletic Therapy");
    expect(row.title).toBe("Physiotherapy vs Athletic Therapy");
    expect(html).not.toMatch(/<h1\b/);
    expect(prompts[0].research?.peopleAlsoAsk).toHaveLength(3);

    // 1. A health topic: the reviewer the site names, the disclaimer, and the decision saved for the publisher.
    expect(prompts[0].sensitive?.kind).toBe("health");
    expect(html).toContain("Reviewed by Sam Lee, Registered Physiotherapist.");
    expect(html).toContain("not medical advice");
    expect(result.research.trust?.reviewer?.name).toBe("Sam Lee");

    // 2. The association named as regulator is a claim for review, not a clean check.
    expect(result.factCheck.claims.some((c) => c.kind === "authority" && c.text === "Northland Physiotherapy Association")).toBe(true);
    expect(result.factCheck.verdict).toBe("review");
    expect(row.fact_check_verdict).toBe("review");

    // 4. The call to action links the topic's service page and the saved phone number.
    expect(html).toContain(`href="${O}/services/`);
    expect(html).toContain('href="tel:+15550102030"');

    // And the reviewer is told everything the draft could not settle itself.
    const notes = result.research.reviewNotes ?? [];
    expect(notes.join("\n")).toMatch(/Publish only once Sam Lee has reviewed it/);
    expect(notes.join("\n")).toMatch(/state no figure this draft could cite/);
    expect(notes.join("\n")).toMatch(/Title shortened from 77 to 33 characters/);
    expect(notes.join("\n")).toMatch(/No FAQ section, although the search results show 3 questions/);
  });

  it("puts the picker's request for the owner's input at the top of the review notes", async () => {
    const ask = "Needs your input before publishing: check each clinical statement.";
    const result = await generateArticle({
      supabase: client(), workspaceId: "ws1", keyword: "physiotherapy vs athletic therapy", callerEmail: null,
      selection: { reasons: ["r"], score: 1, difficulty: null, volume: null, reviewNotes: [ask] },
    });
    expect(result.research.reviewNotes?.[0]).toBe(ask);
  });
});
