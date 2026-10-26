// ---------------------------------------------------------------------------
// A first look whose budget runs short, end to end, on the local database
// ---------------------------------------------------------------------------
//
// A production first look (2026-10-15): discovery spent $0.35, its buyer test
// $0.22 judging 360 phrases, and the $0.08 left could not pay for one batch's
// claim (~$0.085, for a reply that costs ~$0.025) nor judge a results page,
// so nothing was planned. This runs the real pipeline - the run budget's
// claim and settle functions in Postgres, the buyer test, the first look's
// planner (its one suggestion call, the results pages, the writes) - with
// only the paid edges and the site replaced by stand-ins that claim, answer
// and bill as the real ones do. It shows the run:
//
// - finishes, in bounded time, with every phase settled;
// - leaves the plan room after the research (`leavingRoom`), so the
//   suggestion is asked, results pages are read and a plan is made;
// - never commits past the research's share of the dollar.
//
// Seeds one account (acme-*.example) and deletes it at the end.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ phrases: [] as string[], rnd: (): number => 0.5 }));
vi.mock("@/lib/domain/reachable", () => ({ checkDomainReachable: async () => ({ ok: true, verdict: "live", url: "https://acme.example" }) }));
vi.mock("../site-text", () => ({ readSiteText: async () => ({ text: "word ".repeat(200), source: "static", chars: 1000 }) }));
vi.mock("@/lib/voice/train", async () => {
  const { claimSpend } = await import("@/lib/billing/spend-scope");
  return { trainVoiceProfile: async () => { const c = await claimSpend("voice", 0.02); await c.settle(0.011); } };
});
vi.mock("../site-assessment", () => ({ assessExistingPages: async () => ({ status: "done", detail: "Read 3 pages.", summary: null }) }));
vi.mock("@/lib/linking/detect", () => ({ detectLinks: async () => ({ found: 0, added: 0 }) }));
vi.mock("@/lib/content/generate", () => ({ generateArticle: async () => { throw new Error("the draft is dispatched, not written, in this test"); } }));
// The model: the buyer test's answers and the first look's suggestion, billed as measured.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async (p: { messages: Array<{ content: string | Array<{ text: string }> }> }) => {
        // The results judge sends its cached instructions and its data as two blocks.
        const content = p.messages[0].content;
        const prompt = typeof content === "string" ? content : content.map((b) => b.text).join("");
        await new Promise((r) => setTimeout(r, 50 + h.rnd() * 400));
        if (prompt.startsWith("You choose the first article for a website.")) {
          // The searches already found, as the prompt lists them: the first twenty, as asked.
          const found = [...prompt.matchAll(/^- (model railway kit idea \d{4}) \(/gm)].map((m) => m[1]).slice(0, 20);
          const topics = found.map((query) => ({ query, fromList: true, reader: "railway modellers", job: "choose a kit", offering: "model railway kits", angle: `How to choose ${query}`, shape: "explainer", fit: 4, kind: "question", why: "Modellers ask it before they buy." }));
          return { content: [{ type: "text", text: JSON.stringify({ topics }) }], usage: { input_tokens: 4200, output_tokens: 120 * topics.length } };
        }
        const at = prompt.lastIndexOf("PHRASES\n");
        if (at !== -1) {
          const asked = JSON.parse(prompt.slice(at + "PHRASES\n".length)) as string[];
          const text = JSON.stringify({ verdicts: asked.map((t) => ({ t, s: "solution", r: "a modeller choosing a kit" })) });
          return { content: [{ type: "text", text }], usage: { input_tokens: 1800, output_tokens: 55 * asked.length } };
        }
        if (prompt.includes('"results"')) {
          const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as { query: string; results: unknown[] };
          const text = JSON.stringify({ stage: "solution", kinds: data.results.map(() => "article"), reason: "Modellers choosing a kit", audience: "railway modellers", buyingJob: "choose a kit", offering: "model railway kits", angle: `How to choose ${data.query}`, shape: "explainer", conversionPath: "https://acme.example" });
          return { content: [{ type: "text", text }], usage: { input_tokens: 3500, output_tokens: 250 } };
        }
        return { content: [{ type: "text", text: "{}" }], usage: { input_tokens: 500, output_tokens: 50 } };
      },
    };
  },
}));
// DataForSEO: claims its estimate, bills half of it, and answers a results page of articles.
vi.mock("@/lib/seo/client", async (original) => {
  const real = await original<typeof import("@/lib/seo/client")>();
  const { claimSpend } = await import("@/lib/billing/spend-scope");
  const { estimateDataForSEOUsd } = await import("@/lib/seo/dataforseo-cost");
  return {
    ...real,
    hasDataForSEOCredentials: () => true,
    get: async () => ({ tasks: [] }),
    post: async (endpoint: string, body: Array<{ keyword?: string }>) => {
      const estimate = estimateDataForSEOUsd(endpoint, body);
      const claim = await claimSpend(real.spendOperation(endpoint), estimate);
      await new Promise((r) => setTimeout(r, 30 + h.rnd() * 200));
      await claim.settle(estimate / 2);
      if (!endpoint.includes("/live/advanced")) return { cost: estimate / 2, tasks: [] };
      const keyword = body[0]?.keyword ?? "";
      const items = Array.from({ length: 8 }, (_, i) => ({ type: "organic", rank_group: i + 1, title: `${keyword}: a guide (${i + 1})`, url: `https://guide-${i}.example/${encodeURIComponent(keyword)}`, description: "A guide", domain: `guide-${i}.example` }));
      return { cost: estimate / 2, tasks: [{ result: [{ items }] }] };
    },
  };
});
// Discovery: its provider spend as measured ($0.351 over 23 calls), then the
// real buyer test over the whole pool, best first, then the kept phrases stored.
vi.mock("@/lib/audit/domain-analysis", async () => {
  const { claimSpend, withStage } = await import("@/lib/billing/spend-scope");
  const { judgeBuyerFit } = await import("@/lib/keyword-research/buyer-fit");
  return {
    analyseDomain: async (o: { supabase: import("@supabase/supabase-js").SupabaseClient; workspaceId: string; profile: Record<string, unknown> }) => {
      for (let i = 0; i < 23; i++) {
        const c = await claimSpend("/dataforseo_labs/google/ranked_keywords/live", 0.03);
        await c.settle(0.351 / 23);
      }
      const fit = await withStage("buyer_fit", () => judgeBuyerFit({ ...o.profile, language: "en" }, h.phrases, { prioritized: true }));
      const rows = h.phrases.filter((t) => fit.verdicts.get(t)?.keep).slice(0, 100).map((term, i) => ({
        workspace_id: o.workspaceId, term, volume: 900 - i, difficulty: 10, status: "new", source: "ideas", source_type: "profile", buyer_fit: fit.verdicts.get(term),
      }));
      if (rows.length) {
        const { error } = await o.supabase.from("keywords").upsert(rows, { onConflict: "workspace_id,term", ignoreDuplicates: true });
        if (error) throw new Error(error.message);
      }
      return { keywordsFound: rows.length, layers: [{ id: "keywords", status: "ok", detail: `${rows.length} keywords found` }], screened: undefined };
    },
  };
});

import { createServiceClient } from "@/lib/supabase/server";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import { runOnboarding } from "../pipeline";
import { FIRST_LOOK_DRAFT_RESERVE_USD, readRunBudget } from "@/lib/billing/run-budget";
import type { OnboardingEvent } from "../events";

const STACK = await connectLocalStack();
const TAG = `b20-look-${randomUUID().slice(0, 8)}`;
const DOMAIN = `acme-${TAG}.example`;
const BUSINESS = { name: "Acme Studio", description: "Acme Studio sells model railway kits and scenery to hobbyists.", offerings: ["model railway kits"], audiences: ["railway modellers"] };
/** Long enough for a run of this size many times over; a run that hangs never ends. */
const BOUND_MS = 60_000;

describe.skipIf(!STACK)("a first look whose budget runs short", () => {
  let db: ReturnType<typeof createServiceClient>;
  let accountId = "";
  let workspaceId = "";

  async function firstLook(seed: number) {
    let s = seed;
    h.rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const { data: run, error } = await db.from("onboarding_runs").insert({ workspace_id: workspaceId, account_id: accountId }).select("id").single();
    if (error || !run) throw new Error(`onboarding_runs: ${error?.message}`);
    const events: OnboardingEvent[] = [];
    const started = Date.now();
    const done = runOnboarding(db, { id: workspaceId, domain: DOMAIN, account_id: accountId, language: "en", location_code: 2840, business_profile: BUSINESS }, (e) => events.push(e), { firstDraft: "dispatch", runId: run.id as string });
    const outcome = await Promise.race([done, new Promise<"hung">((r) => setTimeout(() => r("hung"), BOUND_MS))]);
    const ms = Date.now() - started;
    await db.from("onboarding_runs").update({ status: "done" }).eq("id", run.id);
    return { outcome, events, ms, budget: (await readRunBudget(db, run.id as string))! };
  }
  const last = (events: OnboardingEvent[], phase: string) => [...events].reverse().find((e) => e.phase === phase && "status" in e) as { status: string; detail?: string } | undefined;

  beforeAll(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
    db = createServiceClient();
    const { data, error } = await db.from("accounts").insert({ name: `${TAG} account`, slug: TAG }).select("id").single();
    if (error || !data) throw new Error(`accounts: ${error?.message}`);
    accountId = data.id as string;
    const ws = await db.from("workspaces").insert({ account_id: accountId, name: DOMAIN, domain: DOMAIN, initials: "AC", color: "av-c1", business_profile: BUSINESS, language: "en", location_code: 2840 }).select("id").single();
    if (ws.error || !ws.data) throw new Error(`workspaces: ${ws.error?.message}`);
    workspaceId = ws.data.id as string;
    // A pool bigger than the research's share can judge: 600 phrases, 15 batches.
    h.phrases = Array.from({ length: 600 }, (_, i) => `model railway kit idea ${String(i).padStart(4, "0")}`);
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (accountId) await db.from("accounts").delete().eq("id", accountId);
  }, 30_000);

  it("finishes, reads results pages with the room the research left, and plans", async () => {
    const { outcome, events, ms, budget } = await firstLook(11);
    expect(outcome).not.toBe("hung");
    expect(ms).toBeLessThan(BOUND_MS);
    // Every phase settled; the draft is handed on with its keyword.
    for (const phase of ["scanning", "keywords", "pages", "planning"]) expect(last(events, phase)?.status).not.toBe("active");
    expect(last(events, "keywords")?.status).toBe("done");
    expect(last(events, "planning")?.status).toBe("done");
    expect(outcome !== "hung" && outcome.pendingDraft?.term).toBeTruthy();
    // The buyer test stopped short of the whole pool, at its share.
    expect(budget.stages.buyer_fit?.calls).toBeGreaterThan(0);
    // The plan was not starved: its one suggestion was asked and results pages were read.
    expect(budget.stages.judge?.calls).toBe(1);
    expect(budget.stages.results_pages?.calls ?? 0).toBeGreaterThanOrEqual(3);
    expect((last(events, "planning") as { planned?: unknown[] }).planned?.length ?? 0).toBeGreaterThanOrEqual(3);
    // The research never touched the draft's reserve.
    expect(budget.committedUsd).toBeLessThanOrEqual(1 - FIRST_LOOK_DRAFT_RESERVE_USD + 1e-6);
  }, BOUND_MS + 30_000);

  it("finishes again when the same site is looked at a second time", async () => {
    const { outcome, events, ms } = await firstLook(12);
    expect(outcome).not.toBe("hung");
    expect(ms).toBeLessThan(BOUND_MS);
    for (const phase of ["scanning", "keywords", "pages", "planning"]) expect(last(events, phase)?.status).not.toBe("active");
  }, BOUND_MS + 30_000);
});
