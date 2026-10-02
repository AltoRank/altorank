import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SiteFacts, ArticlePrompt } from "@/lib/ai/types";
import { extractArticleMeta } from "@/lib/ai/utils";
import { buildResearchSection, buildSystemPrompt } from "@/lib/ai/prompts";

// The whole generation path, from the results page to the saved fact check,
// for a clinic whose search is ranked mostly by other clinics: the failure of
// the live first articles of 2026-10-01, where the writer cited rival
// businesses as the authority for its figures. Every paid call is mocked and
// every site is invented; the research, the classification, the prompt, the
// scrub and the fact check are production's code.

const DOMAIN = "acme-physio.example";
const O = `https://${DOMAIN}`;

const RIVAL_NAMED = "https://www.rival-physio.example/blog/back-pain-stats"; // the owner named it
const RIVAL_SAME = "https://bramble-clinic.example/guide/back-pain"; // the model reads it as same_service
const GOV = "https://health.gov.example.gov/back-pain"; // code: government
const ASSOC = "https://physio-association.example/facts"; // the model reads it as information
const SHOP = "https://brace-shop.example/back-braces"; // the model reads it as supplier_retailer

const PAGES: Record<string, string> = {
  [RIVAL_NAMED]: "About 41% of adults with back pain recover within six weeks of their first visit to a clinic.",
  [RIVAL_SAME]: "Our clinic has treated 37.4% more back pain patients this year than the regional average.",
  [GOV]: "Low back pain affects 619 million people worldwide according to the latest public health estimates.",
  [ASSOC]: "Members of the association report that 80% of patients return to work within three months.",
  [SHOP]: "Our braces are recommended by 92% of customers who stand all day at work and want support.",
};

const { serp, fetchSite, ask } = vi.hoisted(() => ({ serp: vi.fn(), fetchSite: vi.fn(), ask: vi.fn() }));

vi.mock("@/lib/seo/brief-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/brief-data")>()),
  fetchAdvancedSerp: (...a: unknown[]) => serp(...a),
  fetchRelatedKeywords: async () => [],
}));
vi.mock("@/lib/seo/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/client")>()),
  hasDataForSEOCredentials: () => true,
}));
vi.mock("@/lib/seo/keywords", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/keywords")>()),
  fetchKeywordFacts: async () => new Map(),
}));
vi.mock("@/lib/audit/lenient-fetch", () => ({ fetchSite: (...a: unknown[]) => fetchSite(...a) }));
vi.mock("@/lib/keyword-research/buyer-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/keyword-research/buyer-model")>()),
  askStructured: (...a: unknown[]) => ask(...a),
  modelAvailable: () => true,
}));
vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: async () => ({ limit: null, used: 0, remaining: null, reason: "plan", plan: "agency" }),
}));
vi.mock("@/lib/billing/spend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/spend")>()),
  recordSpend: async () => undefined,
}));
vi.mock("@/lib/billing/default-spend", () => ({ spendClient: () => null }));
vi.mock("@/lib/ai/article-questions", () => ({
  selectArticleQuestions: async (q: string[]) => ({ status: "qualified", kept: q, decisions: [] }),
}));

const FACTS: SiteFacts = {
  pagesRead: 2,
  offerings: [{ name: "Back Pain Physiotherapy", url: `${O}/services/back-pain` }],
  work: [],
  headings: [],
  stated: [],
  about: null,
  people: [],
  pages: [],
  conversion: null,
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

/**
 * What a writer that ignores the brief would produce: a rival named by the
 * owner linked for its figure, a same-service clinic's figure with its link,
 * and the public source cited properly.
 */
const MODEL_HTML =
  "<p>Back pain physiotherapy helps most people move again within weeks, and the evidence for exercise-based care is strong.</p>" +
  `<h2>How common is back pain?</h2><p>Low back pain affects 619 million people worldwide, according to <a href="${GOV}">the public health office</a>.</p>` +
  `<h2>How fast do people recover?</h2><p>About 41% of adults recover within six weeks, says <a href="${RIVAL_NAMED}">Rival Physio</a>.</p>` +
  `<p>Clinics have seen 37.4% more back pain patients this year, as <a href="${RIVAL_SAME}">a recent clinic report</a> shows.</p>` +
  "<meta-description>Back pain physiotherapy: what helps and how fast.</meta-description>";

const prompts: ArticlePrompt[] = [];
vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: () => ({
    async *streamArticle(prompt: ArticlePrompt) {
      prompts.push(prompt);
      yield MODEL_HTML;
      const meta = extractArticleMeta(MODEL_HTML);
      return { html: meta.cleanHtml, title: "Back Pain Physiotherapy", metaDescription: meta.metaDescription, wordCount: 80, tokensUsed: 10, inputTokens: 5, outputTokens: 5 };
    },
  }),
}));

import { generateArticle } from "../generate";

const saved: Record<string, unknown>[] = [];

function client() {
  const workspace = {
    id: "ws1", account_id: "acc1", domain: DOMAIN, ai_provider: null, ai_model: null, language: "en", brand_style: null,
    location_code: null, status: "active", paused_until: null,
    business_profile: {
      name: "Acme Physio",
      description: "A physiotherapy clinic treating back pain and sports injuries.",
      offerings: ["back pain physiotherapy", "sports physiotherapy"],
      competitors: ["rival-physio.example"],
    },
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

const result = (rank: number, url: string, title: string) => ({
  rank, url, title, domain: new URL(url).hostname, description: PAGES[url], wordCount: null,
});

// The citation check opens every cited page once: answered here with the
// page's own text, as a GET would.
vi.stubGlobal("fetch", async (input: string | URL) => {
  const url = String(input);
  const text = PAGES[url];
  return new Response(text ? `<html><body><p>${text}</p><p>${"Filler about back pain. ".repeat(40)}</p></body></html>` : "", {
    status: text ? 200 : 404,
    headers: { "content-type": "text/html" },
  });
});

beforeEach(() => {
  saved.length = 0;
  prompts.length = 0;
  serp.mockReset();
  fetchSite.mockReset();
  ask.mockReset();
  serp.mockResolvedValue({
    organic: [
      result(1, RIVAL_NAMED, "Back pain recovery statistics"),
      result(2, RIVAL_SAME, "Back pain treatment guide"),
      result(3, GOV, "Low back pain fact sheet"),
      result(4, ASSOC, "Physiotherapy facts"),
      result(5, SHOP, "Back braces"),
    ],
    peopleAlsoAsk: [],
    aiOverview: null,
  });
  fetchSite.mockImplementation(async (url: string) => {
    const body = `<html><body><main><p>${PAGES[url]}</p><p>${"More words about back pain and recovery. ".repeat(40)}</p></main></body></html>`;
    return { ok: true, status: 200, text: async () => body };
  });
  ask.mockImplementation(async () =>
    JSON.stringify({
      sources: [
        { host: "bramble-clinic.example", class: "same_service" },
        { host: "physio-association.example", class: "information" },
        { host: "brace-shop.example", class: "supplier_retailer" },
      ],
    }),
  );
});

describe("a draft researched on a results page held by rival clinics", () => {
  it("offers only public figures, names the sellers, strips their links and reads a rival's figure as high risk", async () => {
    const out = await generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "back pain physiotherapy", callerEmail: null });

    // One structured call for the draft, about the hosts code could not place.
    const classify = ask.mock.calls.filter((c) => c[0] === "content/source-classes");
    expect(classify).toHaveLength(1);
    const sites = (JSON.parse(String(classify[0][1]).split("\n").pop()!) as { sites: { host: string }[] }).sites.map((s) => s.host);
    // The owner named one rival and one site is government: code placed both.
    expect(sites).toEqual(["bramble-clinic.example", "physio-association.example", "brace-shop.example"]);

    // The writer was offered the public figures only.
    const research = prompts[0].research!;
    const offered = (research.sourceFigures ?? []).map((f) => new URL(f.url).hostname);
    expect(offered.sort()).toEqual(["health.gov.example.gov", "physio-association.example"]);
    const held = research.sourceReview!.heldBack.map((f) => `${new URL(f.url).hostname}:${f.class}`).sort();
    expect(held).toEqual(["brace-shop.example:supplier_retailer", "bramble-clinic.example:same_service", "www.rival-physio.example:named_rival"]);

    // And told who sells the same service.
    const section = buildResearchSection(research).join("\n\n");
    expect(section).toContain("BUSINESSES THAT SELL WHAT THIS BUSINESS SELLS");
    expect(section).toMatch(/- bramble-clinic\.example/);
    expect(section).toMatch(/- rival-physio\.example/);
    expect(section).toMatch(/"Back pain recovery statistics" \(www\.rival-physio\.example[^)]*\) \[sells what this business sells/);
    expect(section).not.toMatch(/Low back pain fact sheet.*\[sells/);
    const system = buildSystemPrompt(prompts[0]);
    expect(system).toContain("Never cite, quote or link a business that sells what this business sells");

    // No link to a seller survives; its words do; the public link stays.
    expect(out.html).not.toContain("rival-physio.example");
    expect(out.html).not.toContain("bramble-clinic.example");
    expect(out.html).toContain("Rival Physio");
    expect(out.html).toContain(`href="${GOV}"`);
    const removed = out.research.sourceReview!.removedLinks!.map((r) => `${r.host}:${r.class}:${r.text}`).sort();
    expect(removed).toEqual(["bramble-clinic.example:same_service:a recent clinic report", "rival-physio.example:named_rival:Rival Physio"]);

    // The figures that came from rivals are high risk, the public one is not.
    const rival = out.factCheck.claims.filter((c) => c.status === "rival_source").map((c) => c.figures[0]).sort();
    expect(rival).toEqual(["37.4%", "41%"]);
    expect(out.factCheck.claims.find((c) => c.text.includes("619 million"))?.status).not.toBe("rival_source");
    expect(out.factCheck.verdict).toBe("high_risk");
    const row = saved.find((r) => "content" in r)!;
    expect(row.fact_check_verdict).toBe("high_risk");

    // The reviewer is told what was held back and what was removed.
    const notes = (out.research.reviewNotes ?? []).join("\n");
    expect(notes).toMatch(/kept from the writer/);
    expect(notes).toMatch(/Removed 2 links to businesses that sell what you sell/);
  });

  it("offers no figure from an unclassified site when the classifier gives no usable answer", async () => {
    ask.mockImplementation(async () => "not json");
    const out = await generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "back pain physiotherapy", callerEmail: null });
    const offered = (prompts[0].research!.sourceFigures ?? []).map((f) => new URL(f.url).hostname);
    expect(offered).toEqual(["health.gov.example.gov"]);
    expect(out.research.sourceReview!.model).toBe("failed");
    expect(out.research.layers.find((l) => l.id === "sources")?.status).toBe("failed");
    // The owner's named rival is still known without the model, and its link still goes.
    expect(out.html).not.toContain("rival-physio.example");
    expect((out.research.reviewNotes ?? []).join("\n")).toMatch(/could not be classified/);
  });

  it("still lists, strips and checks the owner's named rivals when the results page returned nothing", async () => {
    serp.mockResolvedValue({ organic: [], peopleAlsoAsk: [], aiOverview: null });
    const out = await generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "back pain physiotherapy", callerEmail: null });
    expect(ask.mock.calls.filter((c) => c[0] === "content/source-classes")).toHaveLength(0);
    const review = out.research.sourceReview!;
    expect(review.rivals).toContain("rival-physio.example");
    expect(buildResearchSection(prompts[0].research!).join("\n\n")).toMatch(/- rival-physio\.example/);
    expect(out.html).not.toContain("rival-physio.example");
    expect(review.removedLinks!.map((r) => r.host)).toContain("rival-physio.example");
    expect(out.factCheck.claims.find((c) => c.figures.includes("41%"))?.status).toBe("rival_source");
  });
});
