import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ArticleResearch } from "@/lib/seo/research";
import type { SiteFacts } from "@/lib/ai/types";

// generateArticle against its deadline (lib/onboarding/time-limits.ts), with
// the real writer (lib/ai/claude.ts) over a stand-in SDK, the real
// enrichment and the real image generator over a stand-in OpenAI client.
// Every limit is shortened so the test takes a second; the stand-ins stall
// without ever looking at the signal they are given, so only the draft's own
// waits can end them. Every paid call is mocked; the site is invented.

vi.mock("@/lib/onboarding/time-limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/onboarding/time-limits")>()),
  DRAFT_SAVE_MS: 100,
  DRAFT_FACT_CHECK_MS: 100,
  DRAFT_FINISH_MS: 400,
  DRAFT_WRITER_MIN_MS: 200,
  DRAFT_OUTLINE_MS: 300,
  DRAFT_LOOKUP_MS: 100,
  DRAFT_LINK_CHECK_MS: 100,
  DRAFT_VIDEO_MS: 100,
  DRAFT_IMAGES_MS: 300,
  DRAFT_ENRICH_TAIL_MS: 50,
  IMAGE_CALL_MS: 250,
}));
vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: async () => ({ limit: null, used: 0, remaining: null, reason: "plan", plan: "agency" }),
}));
const { spend } = vi.hoisted(() => ({ spend: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/billing/spend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/spend")>()),
  recordSpend: async (_db: unknown, row: Record<string, unknown>) => { spend.push(row); },
}));
vi.mock("@/lib/billing/default-spend", () => ({ spendClient: () => null, recordSpendByDefault: () => undefined }));

const words = (n: number, w = "booking") => Array.from({ length: n }, () => w).join(" ");
const RESEARCH: ArticleResearch = {
  keyword: "acme booking cost",
  language: "English",
  intent: { intent: "info", confidence: "high", signals: [], lexicon: true },
  competitors: [{ rank: 1, title: "Booking software prices", url: "https://rival.example/p", domain: "rival.example", description: "", wordCount: 1400 }],
  peopleAlsoAsk: ["How much does it cost?"],
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

const plan = vi.hoisted(() => ({
  writer: "whole" as "whole" | "stall",
  outline: "answer" as "answer" | "stall",
  images: "answer" as "answer" | "stall",
  imageCalls: 0,
  writerAborted: 0,
  log: [] as string[],
}));
const OUTLINE_REPLY = JSON.stringify({ title: "Acme booking cost for a small clinic", sections: ["What does it cost?", "How to choose"], sources: [] });
const BODY = [
  "<h1>Acme booking cost</h1><p>Booking software costs a clinic little.</p>",
  `<h2>Key takeaways</h2><p>${words(90)}</p>`,
  `<h2>What does it cost?</h2><p>${words(120, "cost")}</p>`,
  `<h2>How to choose</h2><p>${words(120, "choose")}</p>`,
  `<h2>Frequently asked questions</h2><h3>How much does it cost?</h3><p>${words(90, "faq")}</p>`,
].join("\n");
vi.mock("@/lib/keyword-research/buyer-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/keyword-research/buyer-model")>()),
  askStructured: async (operation: string) => {
    plan.log.push(`ask:${operation}`);
    if (plan.outline === "stall") await new Promise(() => undefined);
    return OUTLINE_REPLY;
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      stream: () => ({
        abort: () => { plan.writerAborted += 1; },
        [Symbol.asyncIterator]: async function* () {
          plan.log.push("writer");
          yield { type: "message_start", message: { usage: { input_tokens: 8_000 } } };
          yield { type: "content_block_delta", delta: { type: "text_delta", text: BODY.slice(0, 200) } };
          if (plan.writer === "stall") await new Promise(() => undefined);
          yield { type: "content_block_delta", delta: { type: "text_delta", text: BODY.slice(200) } };
          yield { type: "message_delta", usage: { output_tokens: 1_500 } };
        },
        finalMessage: async () => ({ stop_reason: "end_turn", usage: { input_tokens: 8_000, output_tokens: 1_500 } }),
      }),
    };
  },
}));
// A tiny valid base64 payload stands in for the image.
vi.mock("openai", () => ({
  default: class {
    images = {
      generate: async () => {
        plan.imageCalls += 1;
        if (plan.images === "stall") await new Promise(() => undefined);
        return { data: [{ b64_json: Buffer.from("img").toString("base64") }] };
      },
    };
  },
}));
vi.mock("@/lib/storage/images", () => ({
  imageWriter: () => ({}),
  uploadImageBuffer: async (_w: unknown, _d: unknown, path: string) => `https://img.example/${path}`,
}));

import { generateArticle } from "../generate";
import { withSpendScope } from "@/lib/billing/spend-scope";
import { memoryRunBudget } from "@/lib/billing/run-budget";
import { GenerationTimedOutError } from "@/lib/ai/errors";

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

const saved = () => updates.find((u) => u.table === "articles" && u.row.content)?.row ?? null;

beforeEach(() => {
  updates.length = 0;
  spend.length = 0;
  Object.assign(plan, { writer: "whole", outline: "answer", images: "answer", imageCalls: 0, writerAborted: 0, log: [] });
  process.env.ANTHROPIC_API_KEY = "test-key";
});
afterEach(() => {
  delete process.env.OPENAI_API_KEY;
});

describe("a draft against its deadline", () => {
  it("stops a writer that stalls for ever, saves none of it, keeps the outlined row owed and the claim at its estimate", async () => {
    plan.writer = "stall";
    const budget = memoryRunBudget("run-t", 2, {});
    let ready = false;
    const started = Date.now();
    // The writer must stop DRAFT_FINISH_MS (400ms here) before the deadline.
    const err = await withSpendScope({ budget, stage: "draft" }, () => generateArticle({
      supabase: client(), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null, relatedKeywords: [],
      deadline: Date.now() + 1_200,
      outline: { onReady: () => { ready = true; }, keepOnFailure: true },
    })).catch((e: unknown) => e);
    const ms = Date.now() - started;

    expect(err).toBeInstanceOf(GenerationTimedOutError);
    expect(ready).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(ms).toBeLessThan(1_200);
    expect(plan.writerAborted).toBe(1);
    // Nothing partial saved: no content, the outlined row back at drafting, the job failed.
    expect(saved()).toBeNull();
    const articleWrites = updates.filter((u) => u.table === "articles");
    expect(articleWrites.at(-1)?.row).toMatchObject({ status: "drafting" });
    expect(articleWrites.some((u) => u.row.status === "error")).toBe(false);
    expect(updates.find((u) => u.table === "generation_jobs" && u.row.status === "failed")?.row.error).toMatch(/writer was stopped/);
    // The claim keeps its estimate, and the ledger says a call was made at no known price.
    expect(budget.state().committedUsd).toBeGreaterThan(0.3);
    expect(spend).toContainEqual(expect.objectContaining({ provider: "anthropic", costUsd: null, articleId: "a1", runId: "job1" }));
  });

  it("does not start a writer the research and the outline left too little time", async () => {
    const budget = memoryRunBudget("run-s", 2, {});
    const err = await withSpendScope({ budget, stage: "draft" }, () => generateArticle({
      supabase: client(), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null, relatedKeywords: [],
      // 500ms: the writer would have 100ms, under DRAFT_WRITER_MIN_MS.
      deadline: Date.now() + 500,
    })).catch((e: unknown) => e);
    expect((err as Error).name).toBe("OutOfTimeError");
    expect(plan.log).not.toContain("writer");
    expect(budget.state().committedUsd).toBe(0);
    expect(updates.some((u) => u.table === "articles" && u.row.status === "error")).toBe(true);
  });

  it("writes without an outline when the outline call never answers, and says nothing is ready", async () => {
    plan.outline = "stall";
    let ready = false;
    const result = await generateArticle({
      supabase: client(), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null, relatedKeywords: [],
      deadline: Date.now() + 3_000,
      outline: { onReady: () => { ready = true; }, keepOnFailure: true },
    });
    expect(ready).toBe(false);
    expect(plan.log).toContain("writer");
    expect(result.wordCount).toBeGreaterThan(300);
    expect(saved()).toMatchObject({ status: "review" });
  });

  it("saves the body when the images never answer, without them, long before the deadline", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    plan.images = "stall";
    const started = Date.now();
    const result = await generateArticle({
      supabase: client(), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null, relatedKeywords: [],
      deadline: Date.now() + 5_000,
    });
    const ms = Date.now() - started;
    // A section image (DRAFT_IMAGES_MS) and the hero (IMAGE_CALL_MS), then the save.
    expect(plan.imageCalls).toBe(2);
    expect(ms).toBeLessThan(1_500);
    const row = saved()!;
    expect(row).toMatchObject({ status: "review", featured_image_url: null });
    expect(result.html).not.toContain("<img");
    expect(result.html).toContain("How to choose");
    const enrichment = (row.research as { enrichment?: { images: number; warnings: string[]; cta: boolean } }).enrichment!;
    expect(enrichment.images).toBe(0);
    expect(enrichment.warnings.join(" ")).toMatch(/images stopped at 0 of/);
    // The steps after the images still ran.
    expect(enrichment.cta).toBe(true);
  });

  it("is unchanged when everything answers: the images, the hero and the body are saved", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const result = await generateArticle({
      supabase: client(), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null, relatedKeywords: [],
    });
    expect(result.html).toContain('<img src="https://img.example/ws1/a1-1.webp"');
    expect(saved()).toMatchObject({ status: "review", featured_image_url: "https://img.example/ws1/a1.webp" });
    expect(plan.writerAborted).toBe(0);
    expect(spend).toContainEqual(expect.objectContaining({ provider: "anthropic", inputTokens: 8_000, outputTokens: 1_500 }));
  });
});
