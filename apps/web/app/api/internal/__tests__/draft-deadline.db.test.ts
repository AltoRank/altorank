// ---------------------------------------------------------------------------
// A first look's body whose writer never finishes, on the local database
// ---------------------------------------------------------------------------
//
// /api/internal/draft writes a first look's body after its gate opened on the
// outline (PR #272). The writer streamed with no end-to-end limit, so a
// stream that stalled after its headers held the invocation until the
// platform killed it at 300s: no failed attempt, no retry, the writer's claim
// never settled, and the gate showing an outline nothing would fill.
//
// This runs the real route and the real draft - the run budget's claim and
// settle in Postgres, the owed-body record, the outline, the writer, the
// enrichment, the fact check and the save - with only the paid edges
// replaced: the research and the site read are stand-ins, and the model's
// stream stalls for ever without looking at the signal it is given. Every
// limit is shortened (lib/onboarding/time-limits.ts) so it takes seconds.
//
// Pinned: the stalled attempt ends at the writer's limit, before the
// invocation's; its claim is settled at its estimate; nothing it wrote is
// saved or left streaming; the body stays owed and its retry is recorded and
// sent; nobody is told the draft is ready or that setup failed; and the retry,
// with a writer that answers, writes the body through the existing path.
//
// Seeds one account with invented names (acme-*.example) and deletes it.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  writer: "stall" as "stall" | "whole",
  body: "",
  deferred: [] as Array<() => unknown>,
  sent: [] as Array<{ path: string; body: Record<string, unknown> }>,
  announced: [] as string[],
}));

vi.mock("@/lib/onboarding/time-limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/onboarding/time-limits")>()),
  // An invocation of 6s whose draft must end by 5s; the writer stops at 3.5s.
  DRAFT_INVOCATION_MS: 6_000,
  DRAFT_RECORD_MS: 1_000,
  DRAFT_FINISH_MS: 1_500,
  DRAFT_WRITER_MIN_MS: 500,
  DRAFT_SAVE_MS: 400,
  DRAFT_FACT_CHECK_MS: 300,
  DRAFT_OUTLINE_MS: 1_000,
  DRAFT_LOOKUP_MS: 300,
  DRAFT_LINK_CHECK_MS: 300,
  DRAFT_VIDEO_MS: 300,
  DRAFT_IMAGES_MS: 500,
  DRAFT_ENRICH_TAIL_MS: 100,
  IMAGE_CALL_MS: 400,
}));
vi.mock("next/server", async () => {
  const real = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...real, after: (fn: () => unknown) => { h.deferred.push(fn); } };
});
// The retry's request, kept rather than sent: the test sends it itself.
vi.mock("@/lib/content/fan-out", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content/fan-out")>()),
  selfInvoke: async (path: string, body: Record<string, unknown>) => {
    h.sent.push({ path, body });
    return new Response("{}");
  },
}));
vi.mock("@/lib/email/draft-batch", () => ({
  announceDraftBatch: async (_db: unknown, workspaceId: string) => { h.announced.push(workspaceId); return "1 draft"; },
}));
// An account before its trial, on its first look: the outline gate applies.
vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: async () => ({ limit: 1, used: 0, remaining: 1, reason: "no-plan", plan: null, trialEligible: true }),
}));
// Upstream of the draft: the topic was qualified by the first look.
vi.mock("@/lib/keyword-research/opportunity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/keyword-research/opportunity")>()),
  assertAutonomousTopic: async () => ({ status: "qualified", angle: null, audience: "railway modellers", buyingJob: "choose a kit", offering: "model railway kits", format: "explainer", conversionPath: null, reason: "test" }),
}));
vi.mock("@/lib/seo/research", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/research")>()),
  gatherArticleResearch: async () => ({
    keyword: "acme kits", language: "English",
    intent: { intent: "info", confidence: "high", signals: [], lexicon: true },
    competitors: [{ rank: 1, title: "Kits compared", url: "https://rival.example/kits", domain: "rival.example", description: "", wordCount: 1400 }],
    peopleAlsoAsk: ["What is in a kit?"], aiOverview: null, relatedKeywords: [], existingPerformance: null, adjacentQueries: [],
    recommendedWordCount: 1200, wordCountBasis: "test", layers: [], sourceFigures: [],
  }),
}));
vi.mock("@/lib/ai/article-questions", () => ({
  selectArticleQuestions: async (q: string[]) => ({ status: "qualified", kept: q, decisions: [] }),
}));
vi.mock("@/lib/content/site-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content/site-facts")>()),
  loadSiteFacts: async () => ({
    facts: { pagesRead: 0, offerings: [], work: [], headings: [], stated: [], about: null, people: [], pages: [], conversion: null, notes: [] },
    layer: { id: "site_facts", status: "ok", detail: "test" },
  }),
}));
// The model: the outline answers; the writer's stream stalls after its first
// words and never looks at its signal, or writes the whole body.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify({ title: "Acme kits: how to choose one", sections: ["What is in a kit?", "How to choose one"], sources: [] }) }],
        usage: { input_tokens: 2_000, output_tokens: 120 },
      }),
      stream: () => ({
        abort: () => undefined,
        [Symbol.asyncIterator]: async function* () {
          yield { type: "message_start", message: { usage: { input_tokens: 9_000 } } };
          if (h.writer === "stall") {
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "<h1>Acme kits</h1><p>The first words of a body that " } };
            await new Promise(() => undefined);
          }
          yield { type: "content_block_delta", delta: { type: "text_delta", text: h.body } };
          yield { type: "message_delta", usage: { output_tokens: 1_600 } };
        },
        finalMessage: async () => ({ stop_reason: "end_turn", usage: { input_tokens: 9_000, output_tokens: 1_600 } }),
      }),
    };
  },
}));

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import { openRunBudget } from "@/lib/billing/run-budget";

const STACK = await connectLocalStack();
const TAG = randomUUID().slice(0, 8);

describe.skipIf(!STACK)("a first look's body whose writer never finishes", () => {
  let admin: SupabaseClient;
  let POST: (req: Request) => Promise<Response>;
  let account = "";
  let site = "";
  let run = "";
  let article = "";

  const must = (r: { data: unknown; error: { message: string } | null }, what: string): Record<string, unknown> => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return (r.data ?? {}) as Record<string, unknown>;
  };
  const post = (body: unknown) => POST(new Request("https://app.example/api/internal/draft", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": "cron-secret" },
    body: JSON.stringify(body),
  }));
  const runDeferred = async () => { while (h.deferred.length) await h.deferred.shift()!(); };

  beforeAll(async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.OPENAI_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    delete process.env.TRIAL_GATE_DISABLED;
    admin = createClient(STACK!.url, STACK!.service, { auth: { persistSession: false, autoRefreshToken: false } });
    account = must(await admin.from("accounts").insert({ name: `Acme deadline ${TAG}`, slug: `acme-deadline-${TAG}` }).select("id").single(), "account").id as string;
    site = must(await admin.from("workspaces").insert({ account_id: account, name: `acme-${TAG}.example`, domain: `acme-${TAG}.example`, initials: "AC", color: "av-c1" }).select("id").single(), "site").id as string;
    const phases = ["scanning", "keywords", "pages", "planning"].map((phase) => ({ phase, status: "done" })).concat([{ phase: "drafting", status: "active" }]);
    run = must(await admin.from("onboarding_runs").insert({ workspace_id: site, account_id: account, phases }).select("id").single(), "run").id as string;
    if (!(await openRunBudget(admin, { runId: run, workspaceId: site }))) throw new Error("run budget not opened");
    ({ POST } = (await import("../draft/route")) as unknown as { POST: (req: Request) => Promise<Response> });
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.from("system_events").delete().eq("workspace_id", site);
    await admin.from("provider_spend").delete().eq("workspace_id", site);
    if (account) await admin.from("accounts").delete().eq("id", account);
  }, 60_000);

  it("ends a stalled writer at its limit, keeps the body owed, settles the claim at its estimate and sends the retry", async () => {
    const started = Date.now();
    const res = await post({ workspaceId: site, runId: run, keyword: "acme kits", keywordId: null });
    const ms = Date.now() - started;
    const out = await res.json();
    expect(out).toMatchObject({ status: "owed", attempt: 1 });
    expect(out.error).toMatch(/writer was stopped/);
    // Stopped at the writer's limit (3.5s), recorded before the invocation's ceiling (6s).
    expect(ms).toBeGreaterThanOrEqual(3_400);
    expect(ms).toBeLessThan(5_000);

    // The gate opened on the outline before the writer: the run ended there, untouched since.
    const runRow = must(await admin.from("onboarding_runs").select("status, article_id, phases").eq("id", run).single(), "run") as { status: string; article_id: string; phases: Array<{ phase: string; status: string }> };
    article = runRow.article_id;
    expect(article).toBeTruthy();
    expect(["done", "partial"]).toContain(runRow.status);
    expect(runRow.phases.find((p) => p.phase === "drafting")?.status).toBe("done");

    // Nothing partial saved, nothing left streaming: the outline, and no body.
    const row = must(await admin.from("articles").select("status, content, body_stream, body_progress, word_count, instructions_snapshot").eq("id", article).single(), "article") as Record<string, unknown>;
    expect(row).toMatchObject({ status: "drafting", content: null, body_stream: null, body_progress: null });
    expect((row.instructions_snapshot as { outline?: { sections: string[] } }).outline?.sections.length).toBeGreaterThan(1);
    const job = must(await admin.from("generation_jobs").select("status, error").eq("article_id", article).single(), "job");
    expect(job).toMatchObject({ status: "failed" });
    expect(job.error).toMatch(/writer was stopped/);

    // Every claim settled - none left open - and the writer's at its estimate.
    const budget = must(await admin.from("run_budgets").select("committed_usd, stages").eq("run_id", run).single(), "budget") as { committed_usd: number; stages: Record<string, { committed?: number; spent?: number; calls?: number }> };
    const draft = budget.stages.draft;
    expect(draft.calls).toBe(2); // the outline and the writer
    expect(Number(draft.committed)).toBeCloseTo(Number(draft.spent), 6);
    expect(Number(draft.spent)).toBeGreaterThan(0.2);
    // The ledger says the writer was called, at no price it knew.
    const { data: spendRows } = await admin.from("provider_spend").select("operation, cost_usd").eq("article_id", article).eq("provider", "anthropic");
    expect((spendRows ?? []).some((r) => r.cost_usd === null)).toBe(true);

    // Still owed after one try; the failure is recorded and the retry sent.
    const owed = must(await admin.from("owed_bodies").select("attempts").eq("article_id", article).single(), "owed");
    expect(owed.attempts).toBe(1);
    const { data: events } = await admin.from("system_events").select("level, source, message").eq("workspace_id", site).eq("source", "onboarding.body");
    expect(events).toHaveLength(1);
    expect(events![0].message).toMatch(/attempt 1 of 3\); trying again now: The writer was stopped/);
    await runDeferred();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ path: "/api/internal/draft", body: { workspaceId: site, runId: run, articleId: article, resume: true, attempt: 2 } });
    // Nobody was told it was written.
    expect(h.announced).toEqual([]);
  }, 30_000);

  it("writes the body on the retry, through the existing path, when the writer answers", async () => {
    const snap = must(await admin.from("articles").select("instructions_snapshot").eq("id", article).single(), "snapshot").instructions_snapshot as { outline: { sections: string[] } };
    const prose = (w: string) => `<p>${Array.from({ length: 140 }, () => w).join(" ")}.</p>`;
    h.body = ["<h1>Acme kits</h1>", prose("intro"), ...snap.outline.sections.map((s, i) => `<h2>${s}</h2>${prose(`part${i}`)}`)].join("\n");
    h.writer = "whole";
    const res = await post(h.sent[0].body);
    expect(await res.json()).toMatchObject({ status: "generated", articleId: article });
    const row = must(await admin.from("articles").select("status, content, body_stream, word_count").eq("id", article).single(), "article");
    expect(row.status).toBe("review");
    expect(row.content).not.toBeNull();
    expect(row.body_stream).toBeNull();
    expect(Number(row.word_count)).toBeGreaterThan(300);
    const { data: owed } = await admin.from("owed_bodies").select("article_id").eq("article_id", article);
    expect(owed).toEqual([]);
    expect(h.announced).toEqual([site]);
  }, 30_000);
});
