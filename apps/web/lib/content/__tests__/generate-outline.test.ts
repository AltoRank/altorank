import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ArticleResearch } from "@/lib/seo/research";
import type { SiteFacts } from "@/lib/ai/types";

// generateArticle with an outline first (lib/content/outline.ts): the outline
// is stored and announced before the writer is asked for a word, the body is
// held to it, and a body that fails after the outline was announced stays
// owed rather than errored. Every paid call is mocked; the site is invented.

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
  keyword: "acme booking cost",
  language: "English",
  intent: { intent: "info", confidence: "high", signals: [], lexicon: true },
  competitors: [{ rank: 1, title: "Booking software prices", url: "https://rival.example/p", domain: "rival.example", description: "", wordCount: 1400 }],
  peopleAlsoAsk: ["How much does it cost?", "Is it worth it?"],
  aiOverview: null,
  relatedKeywords: [],
  existingPerformance: null,
  adjacentQueries: [],
  recommendedWordCount: 1200,
  wordCountBasis: "test",
  layers: [],
  sourceFigures: [{ sentence: "Clinics pay 30 a month.", figures: ["30"], url: "https://stats.example/a", domain: "stats.example" }],
};
const { researchHooks } = vi.hoisted(() => ({ researchHooks: { early: false, nul: false, release: null as null | (() => void) } }));
vi.mock("@/lib/seo/research", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/research")>()),
  gatherArticleResearch: async (o: { onSerp?: (s: unknown) => void; onQuestions?: (q: string[]) => void }) => {
    if (researchHooks.early) {
      // The results page is in; the ranking pages are still being read.
      o.onSerp?.({ organic: RESEARCH.competitors.map((c) => ({ ...c })), peopleAlsoAsk: RESEARCH.peopleAlsoAsk, aiOverview: null });
      o.onQuestions?.(RESEARCH.peopleAlsoAsk);
      await new Promise<void>((r) => { researchHooks.release = r; setTimeout(r, 50); });
      log.push("research-done");
    }
    const out = structuredClone(RESEARCH);
    // A results page's text with a NUL in it, as one site's did.
    if (researchHooks.nul) out.competitors[0].description = "Prices\u0000 compared";
    return out;
  },
}));
vi.mock("@/lib/ai/article-questions", () => ({
  selectArticleQuestions: async (q: string[]) => ({ status: "qualified", kept: q, decisions: [] }),
}));
vi.mock("@/lib/content/site-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content/site-facts")>()),
  loadSiteFacts: async () => ({
    facts: { pagesRead: 0, offerings: [], work: [], headings: [], stated: [], about: null, people: [], pages: [], conversion: null, notes: [] } as unknown as SiteFacts,
    layer: { id: "site_facts", status: "ok", detail: "test" },
  }),
}));
vi.mock("@/lib/seo/link-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/link-resolver")>()),
  fetchLinkTargets: async () => [],
}));
vi.mock("@/lib/linking/targets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/linking/targets")>()),
  fetchKnownPages: async () => [],
}));
vi.mock("@/lib/ai/video-embedder", () => ({ embedYouTubeVideos: async (html: string) => html }));
vi.mock("@/lib/seo/link-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/link-check")>()),
  verifyOutboundLinks: async (html: string) => ({ html, checks: [] }),
}));
vi.mock("@/lib/seo/citation-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/citation-check")>()),
  verifyCitedFigures: async (report: unknown) => report,
}));
// The enrichment adds the closing call to action, as the real one does.
vi.mock("@/lib/content/enrich", () => ({
  enrichArticle: async (html: string) => ({ html: `${html}\n<section class="cta"><h2>Learn more about Acme Clinic</h2><p>Visit us.</p></section>` }),
}));

const { log, writerHtml } = vi.hoisted(() => ({ log: [] as string[], writerHtml: { value: "" } }));
vi.mock("@/lib/keyword-research/buyer-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/keyword-research/buyer-model")>()),
  askStructured: async (operation: string) => {
    log.push(`ask:${operation}`);
    return JSON.stringify({
      title: "Acme booking cost for a small clinic",
      summaryHeading: "x",
      sections: ["What does booking software cost?", "What changes the price", "How to choose"],
      faqHeading: "x",
      sources: ["https://stats.example/a"],
    });
  },
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: () => ({
    async *streamArticle(prompt: { outline?: { sections: string[] }; title?: string }) {
      log.push(`writer:${prompt.outline ? prompt.outline.sections.length : "none"}`);
      yield writerHtml.value;
      return { html: writerHtml.value, title: "Something the writer made up", metaDescription: "m", wordCount: 1210, tokensUsed: 10, inputTokens: 5, outputTokens: 5 };
    },
  }),
}));

import { generateArticle } from "../generate";
import { withSpendScope } from "@/lib/billing/spend-scope";
import { memoryRunBudget } from "@/lib/billing/run-budget";
import { h2sOf, OutlineNotFollowedError, type ArticleOutline } from "../outline";

const updates: Array<{ table: string; row: Record<string, unknown> }> = [];

function client() {
  const workspace = {
    id: "ws1", account_id: "acc1", domain: "acme-clinic.example", ai_provider: null, ai_model: null, language: "en", brand_style: null,
    location_code: null, status: "active", paused_until: null, business_profile: { name: "Acme Clinic", description: "A small clinic" },
  };
  return {
    from: (table: string) => {
      if (table === "articles" || table === "generation_jobs") {
        const id = table === "articles" ? "a1" : "job1";
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: { id }, error: null }) }) }),
          update: (row: Record<string, unknown>) => {
            updates.push({ table, row });
            if (table === "articles" && row.instructions_snapshot && (row.instructions_snapshot as { outline?: unknown }).outline && !row.content) log.push("stored-outline");
            return { eq: async () => ({ error: null }) };
          },
          delete: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }),
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

const FOLLOWED = [
  "<h1>Something the writer made up</h1><p>Booking software costs a clinic about 30 a month.</p>",
  "<h2>Key Takeaways</h2><ul><li>It costs little.</li></ul>",
  "<h2>What does booking software cost?</h2><p>a</p>",
  "<h2>An extra section nobody saw</h2><p>kept as a sub-section</p>",
  "<h2>What changes the price</h2><p>b</p>",
  "<h2>How to choose</h2><p>c</p>",
  "<h2>Frequently asked questions</h2><h3>How much does it cost?</h3><p>d</p>",
].join("\n");

beforeEach(() => {
  updates.length = 0;
  log.length = 0;
  writerHtml.value = FOLLOWED;
});

describe("an article outlined before its body", () => {
  it("stores and announces the outline before the writer starts, and the saved H2s are the ones announced", async () => {
    let announced: ArticleOutline | null = null;
    const result = await generateArticle({
      supabase: client(), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null, relatedKeywords: [],
      outline: { onReady: ({ outline }) => { log.push("ready"); announced = outline; }, keepOnFailure: true },
    });
    // Outline asked, stored, announced - and only then the writer, given it.
    const at = (s: string) => log.indexOf(s);
    expect(at("ask:content/outline")).toBeGreaterThanOrEqual(0);
    expect(at("stored-outline")).toBeGreaterThan(at("ask:content/outline"));
    expect(at("ready")).toBeGreaterThan(at("stored-outline"));
    expect(at("writer:5")).toBeGreaterThan(at("ready"));
    expect(announced).not.toBeNull();
    const shown = [...announced!.sections, announced!.closing];
    expect(h2sOf(result.html)).toEqual(shown);
    // The extra section's text is kept, under the section before it.
    expect(result.html).toContain("<h3>An extra section nobody saw</h3><p>kept as a sub-section</p>");
    // The title is the outline's, whatever the writer's <h1> said.
    expect(result.title).toBe("Acme booking cost for a small clinic");
    const saved = updates.find((u) => u.table === "articles" && u.row.content)!.row;
    expect((saved.instructions_snapshot as { outline: ArticleOutline }).outline.sections).toEqual(announced!.sections);
    expect(saved.status).toBe("review");
  });

  it("does not accept a body that dropped a heading the owner saw, and keeps the row owed", async () => {
    writerHtml.value = "<h1>T</h1><p>x</p><h2>Key takeaways</h2><p>y</p><h2>What does booking software cost?</h2><p>z</p>";
    const err = await generateArticle({
      supabase: client(), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null, relatedKeywords: [],
      outline: { onReady: () => undefined, keepOnFailure: true },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OutlineNotFollowedError);
    const articleWrites = updates.filter((u) => u.table === "articles");
    expect(articleWrites.some((u) => u.row.status === "error")).toBe(false);
    expect(articleWrites.at(-1)?.row.status).toBe("drafting");
    expect(articleWrites.some((u) => u.row.content)).toBe(false);
    expect(updates.find((u) => u.table === "generation_jobs" && u.row.status === "failed")).toBeDefined();
  });

  it("errors the row as before when the caller does not keep it", async () => {
    writerHtml.value = "<h1>T</h1><p>x</p><h2>Key takeaways</h2><p>y</p>";
    await generateArticle({
      supabase: client(), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null, relatedKeywords: [],
      outline: { onReady: () => undefined, keepOnFailure: false },
    }).catch(() => null);
    expect(updates.some((u) => u.table === "articles" && u.row.status === "error")).toBe(true);
  });

  it("plans the outline beside the research when the results page arrives first, and gives it the research's sources after", async () => {
    researchHooks.early = true;
    try {
      let announced: ArticleOutline | null = null;
      await generateArticle({
        supabase: client(), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null, relatedKeywords: [],
        outline: { onReady: ({ outline }) => { announced = outline; }, keepOnFailure: true },
      });
      // Asked before the research finished, announced after it.
      expect(log.indexOf("ask:content/outline")).toBeLessThan(log.indexOf("research-done"));
      expect(log.indexOf("stored-outline")).toBeGreaterThan(log.indexOf("research-done"));
      expect(announced!.sources).toEqual(["https://stats.example/a"]);
      expect(announced!.targetWordCount).toBe(1200);
    } finally {
      researchHooks.early = false;
    }
  });

  it("writes with no outline at all when not asked for one", async () => {
    await generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null, relatedKeywords: [] });
    expect(log).toEqual(["writer:none"]);
  });

  it("stores the outline and the article when the research carries a NUL, without it", async () => {
    researchHooks.nul = true;
    try {
      let ready = false;
      await generateArticle({
        supabase: client(), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null, relatedKeywords: [],
        outline: { onReady: () => { ready = true; }, keepOnFailure: true },
      });
      expect(ready).toBe(true);
      const writes = updates.filter((u) => u.table === "articles" && u.row.research);
      expect(writes.length).toBeGreaterThanOrEqual(2);
      for (const w of writes) {
        expect(JSON.stringify(w.row)).not.toContain("\\u0000");
        expect(JSON.stringify(w.row)).toContain("Prices compared");
      }
    } finally {
      researchHooks.nul = false;
    }
  });

  it("does not open the gate on an outline the budget can no longer write", async () => {
    let ready = false;
    const budget = memoryRunBudget("run-o", 0.2, {});
    await withSpendScope({ budget, stage: "draft" }, () => generateArticle({
      supabase: client(), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null, relatedKeywords: [],
      outline: { onReady: () => { ready = true; }, keepOnFailure: true },
    })).catch(() => null);
    expect(ready).toBe(false);
    expect(log).not.toContain("stored-outline");
    expect(log).toContain("writer:none");
  });
});
