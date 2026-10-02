// ---------------------------------------------------------------------------
// Spend scopes and run budgets, on the real call paths
// ---------------------------------------------------------------------------
//
// The paid edges here are real - lib/seo/client.ts `post`, the buyer-model's
// `askStructured`, `fetchAdvancedSerp`, `judgeBuyerFit`, `qualifyOpportunities`
// - and only the network under them is replaced: `fetch` answers as
// DataForSEO does, the Anthropic SDK as the API does. The budget is an
// in-memory copy of migration 106's claim rules (run-budget.db.test.ts runs
// the real ones). What this pins:
//
// - two runs interleaved in one process each bill their own calls: the
//   process-global reporter they replaced billed whichever armed it last;
// - a paid call claims before it is sent, and a refused claim sends nothing;
// - a first look that runs out leaves the rest of its terms not judged -
//   nothing saved, nothing parked - and never commits past its ceiling.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/spend-gate", async (original) => ({
  ...(await original<object>()),
  canSpendOnSite: async () => ({ allowed: true, reason: "plan", message: null }),
}));

import { BudgetRefusedError, claimSpend, currentSpendScope, withSpendScope, withStage, type RunBudget, type SpendStage } from "../spend-scope";
import { post } from "@/lib/seo/client";
import { askStructured } from "@/lib/keyword-research/buyer-model";
import { qualifyOpportunities } from "@/lib/keyword-research/opportunity";
import { generateQualityQuestionsBatch } from "@/lib/keywords/questions";

/** Migration 106's rules, in memory: reserves held for their own stage, claims never past the ceiling. */
function memoryBudget(runId: string, ceilingUsd: number, reserves: Partial<Record<SpendStage, number>> = {}, opts: { keepEstimates?: boolean } = {}) {
  const stages = new Map<SpendStage, { committed: number; spent: number; refused: number }>();
  const at = (s: SpendStage) => stages.get(s) ?? (stages.set(s, { committed: 0, spent: 0, refused: 0 }), stages.get(s)!);
  let committed = 0;
  let peak = 0;
  const claims: Array<{ stage: SpendStage; want: number; granted: number | null }> = [];
  const room = (stage: SpendStage) => ceilingUsd - committed - Object.entries(reserves)
    .filter(([s]) => s !== stage)
    .reduce((sum, [s, r]) => sum + Math.max(0, (r ?? 0) - at(s as SpendStage).committed), 0);
  const budget: RunBudget = {
    runId,
    async claim(stage, want, min) {
      await Promise.resolve();
      const grant = Math.min(want, room(stage));
      if (grant < min) { at(stage).refused++; claims.push({ stage, want, granted: null }); return null; }
      committed += grant; at(stage).committed += grant; peak = Math.max(peak, committed);
      claims.push({ stage, want, granted: grant });
      return grant;
    },
    async settle(stage, granted, actual) {
      await Promise.resolve();
      // keepEstimates: every call settles at its claim, which makes when
      // claims are refused independent of which call answered first.
      const spent = opts.keepEstimates ? granted : Math.max(0, actual ?? granted);
      committed += spent - granted; at(stage).committed += spent - granted; at(stage).spent += spent;
    },
    async room(stage) { return room(stage); },
  };
  return { budget, claims, stages, committed: () => committed, peak: () => peak };
}

/** A database that keeps the spend rows and the keyword writes, and reads back nothing. */
function memoryDb() {
  const spend: Array<Record<string, unknown>> = [];
  const keywordWrites: Array<Record<string, unknown>> = [];
  const chain = (table: string): unknown => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "not", "neq", "gte", "lt", "is", "or", "order", "range", "limit"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: null, error: null });
    q.single = async () => ({ data: null, error: null });
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
    q.insert = async (row: Record<string, unknown>) => { if (table === "provider_spend") spend.push(row); return { error: null }; };
    q.update = (row: Record<string, unknown>) => { if (table === "keywords") keywordWrites.push(row); return q; };
    return q;
  };
  return { db: { from: (t: string) => chain(t), auth: { getUser: async () => ({ data: { user: null } }) } } as never, spend, keywordWrites };
}

/** DataForSEO's envelope for one organic results page. */
function serpResponse(term: string, cost = 0.002) {
  const items = [1, 2, 3, 4].map((n) => ({ type: "organic", rank_group: n, title: `${term} guide ${n}`, url: `https://source-${n}.example/${encodeURIComponent(term)}`, description: "A guide", domain: `source-${n}.example` }));
  return { version: "0.1", status_code: 20000, status_message: "Ok.", time: "0.1", cost, tasks_count: 1, tasks_error: 0, tasks: [{ id: "t", status_code: 20000, status_message: "Ok.", time: "0.1", cost, result_count: 1, path: [], data: {}, result: [{ items }] }] };
}

const usage = { input_tokens: 1_000, output_tokens: 200 };
const reply = (text: string) => ({ content: [{ type: "text", text }], usage, stop_reason: "end_turn" });

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("DATAFORSEO_API_KEY", "dGVzdDp0ZXN0");
  create.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a spend scope", () => {
  it("is seen by everything awaited inside it and by nothing outside", async () => {
    expect(currentSpendScope()).toBeUndefined();
    await withSpendScope({ workspaceId: "ws-a", runId: "run-a" }, async () => {
      await Promise.resolve();
      expect(currentSpendScope()).toMatchObject({ workspaceId: "ws-a", runId: "run-a", stage: null });
      await withStage("judge", async () => {
        await new Promise((r) => setTimeout(r, 1));
        expect(currentSpendScope()).toMatchObject({ workspaceId: "ws-a", stage: "judge" });
      });
      expect(currentSpendScope()?.stage).toBeNull();
    });
    expect(currentSpendScope()).toBeUndefined();
  });

  it("grants every claim at once when there is no budget, and asks nothing", async () => {
    expect((await claimSpend("x", 0.5)).grantedUsd).toBe(0.5);
    await withSpendScope({ workspaceId: "ws" }, async () => {
      expect((await claimSpend("x", 0.5)).grantedUsd).toBe(0.5);
    });
  });

  it("refuses a claim the budget cannot be asked about: a first look that cannot count does not spend", async () => {
    const broken: RunBudget = { runId: "r", claim: async () => { throw new Error("no budget for run r"); }, settle: async () => {}, room: async () => null };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await withSpendScope({ budget: broken }, async () => {
      await expect(claimSpend("x", 0.01)).rejects.toBeInstanceOf(BudgetRefusedError);
    });
    error.mockRestore();
  });
});

describe("DataForSEO under a budget", () => {
  it("claims the estimate before sending, settles what was charged, and sends nothing when refused", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(serpResponse("acme widgets", 0.002)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { db, spend } = memoryDb();
    const run = memoryBudget("run-1", 0.007);
    await withSpendScope({ workspaceId: "ws-1", budget: run.budget, db, stage: "results_pages" }, async () => {
      await post("/serp/google/organic/live/advanced", [{ keyword: "acme widgets" }]);
      // 0.004 claimed, 0.002 charged: 0.005 left, so a second fits; then 0.003, and a third does not.
      await post("/serp/google/organic/live/advanced", [{ keyword: "acme widgets" }]);
      await expect(post("/serp/google/organic/live/advanced", [{ keyword: "acme widgets" }])).rejects.toBeInstanceOf(BudgetRefusedError);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(run.claims.map((c) => [c.stage, c.want, c.granted])).toEqual([["results_pages", 0.004, 0.004], ["results_pages", 0.004, 0.004], ["results_pages", 0.004, null]]);
    expect(run.committed()).toBeCloseTo(0.004, 9);
    expect(run.peak()).toBeLessThanOrEqual(0.007);
    await vi.waitFor(() => expect(spend).toHaveLength(2));
    expect(spend).toEqual([0, 1].map(() => expect.objectContaining({ provider: "dataforseo", workspace_id: "ws-1", run_id: "run-1", stage: "results_pages", cost_usd: 0.002 })));
  });
});

describe("two runs in one process", () => {
  it("each bill their own calls, interleaved however they are", async () => {
    // Every DataForSEO answer waits for the test to release it, so the two
    // runs' calls are in flight together and answer in the opposite order.
    const pending: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init: { body: string }) => new Promise<Response>((resolve) => {
      const keyword = (JSON.parse(init.body) as Array<{ keyword: string }>)[0].keyword;
      pending.push(() => resolve(new Response(JSON.stringify(serpResponse(keyword, keyword.startsWith("a") ? 0.001 : 0.003)), { status: 200 })));
    })));
    create.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 2)); return reply("[]"); });
    const a = { ...memoryDb(), run: memoryBudget("run-a", 1) };
    const b = { ...memoryDb(), run: memoryBudget("run-b", 1) };
    const work = (who: "a" | "b") => async () => {
      await post("/serp/google/organic/live/advanced", [{ keyword: `${who} widgets` }]);
      await withStage("buyer_fit", () => askStructured("keyword-research/buyer-fit", `which of these does ${who} sell`, { maxTokens: 400 }));
    };
    const runs = Promise.all([
      withSpendScope({ workspaceId: "ws-a", runId: "run-a", budget: a.run.budget, db: a.db, stage: "discovery" }, work("a")),
      withSpendScope({ workspaceId: "ws-b", runId: "run-b", budget: b.run.budget, db: b.db, stage: "results_pages" }, work("b")),
    ]);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]();
    pending[0]();
    await runs;
    await vi.waitFor(() => expect(a.spend.length + b.spend.length).toBe(4));
    expect(a.spend).toHaveLength(2);
    expect(a.spend).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "dataforseo", workspace_id: "ws-a", run_id: "run-a", stage: "discovery", cost_usd: 0.001 }),
      expect.objectContaining({ provider: "anthropic", workspace_id: "ws-a", run_id: "run-a", stage: "buyer_fit" }),
    ]));
    expect(b.spend).toHaveLength(2);
    expect(b.spend).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "dataforseo", workspace_id: "ws-b", run_id: "run-b", stage: "results_pages", cost_usd: 0.003 }),
      expect.objectContaining({ provider: "anthropic", workspace_id: "ws-b", run_id: "run-b", stage: "buyer_fit" }),
    ]));
    expect(a.run.stages.get("discovery")?.spent).toBeCloseTo(0.001, 9);
    expect(b.run.stages.get("results_pages")?.spent).toBeCloseTo(0.003, 9);
    expect(a.run.claims.map((c) => c.stage)).toEqual(["discovery", "buyer_fit"]);
    expect(b.run.claims.map((c) => c.stage)).toEqual(["results_pages", "buyer_fit"]);
  });
});

describe("a first look that runs out of budget", () => {
  const business = { name: "Acme Studio", description: "Acme Studio builds booking websites for clinics at a fixed price.", offerings: ["clinic booking websites"], audiences: ["clinic owners"] };
  const context = { domain: "acme-studio.example", languageCode: "en", locationCode: 2840, business };
  const terms = ["clinic booking website cost", "best clinic booking software", "clinic website builder comparison"];
  const candidates = terms.map((term, i) => ({ id: `k${i}`, term }));
  const approval = { stage: "comparing", reason: "Clinic owners compare booking websites", audience: "clinic owners", buyingJob: "choose a booking website", offering: "clinic booking websites", angle: "How clinics choose a booking website", shape: "comparison", conversionPath: "https://acme-studio.example/contact" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const keyword = (JSON.parse(init.body) as Array<{ keyword: string }>)[0].keyword;
      return new Response(JSON.stringify(serpResponse(keyword)), { status: 200 });
    }));
    create.mockImplementation(async (params: { messages: Array<{ content: string }> }) => {
      const prompt = params.messages[0].content;
      if (prompt.startsWith("Who searches this phrase")) return reply(JSON.stringify({ ...approval, kinds: ["article", "article", "article", "article"] }));
      return reply(JSON.stringify(terms.map((t) => ({ t, s: "comparing", r: "clinic owners comparing" }))));
    });
  });

  const qualify = (run: ReturnType<typeof memoryBudget>, db: never) =>
    withSpendScope({ workspaceId: "ws-1", runId: run.budget.runId, budget: run.budget, db }, () =>
      qualifyOpportunities(db, "ws-1", candidates, context, { firstLook: { runId: run.budget.runId } }));

  it("judges every term while the budget covers them, with spend split by stage", async () => {
    const { db, spend, keywordWrites } = memoryDb();
    const run = memoryBudget("run-1", 1, { draft: 0.3, outline_swap: 0.05 });
    const out = await qualify(run, db);
    expect([...out.values()].map((o) => o.status)).toEqual(["qualified", "qualified", "qualified"]);
    expect(keywordWrites).toHaveLength(3);
    expect([...new Set(run.claims.map((c) => c.stage))].sort()).toEqual(["buyer_fit", "judge", "results_pages"]);
    expect(run.claims.every((c) => c.granted !== null)).toBe(true);
    await vi.waitFor(() => expect(spend.filter((r) => r.provider === "dataforseo")).toHaveLength(3));
    expect(new Set(spend.map((r) => r.stage))).toEqual(new Set(["buyer_fit", "results_pages", "judge"]));
  });

  it("stops buying at the ceiling, leaves the rest not judged with nothing saved, and never commits past it", async () => {
    // Measured on an unbounded look: what the buyer test and each read claim.
    const probe = memoryBudget("probe", 100);
    await qualify(probe, memoryDb().db);
    const want = (stage: SpendStage) => probe.claims.find((c) => c.stage === stage)!.want;
    // The buyer test, every results page, and room for one judge read and a half.
    const ceiling = want("buyer_fit") + 3 * want("results_pages") + 1.5 * want("judge");

    const { db, spend, keywordWrites } = memoryDb();
    const run = memoryBudget("run-2", ceiling, {}, { keepEstimates: true });
    const out = await qualify(run, db);
    const judged = candidates.filter((c) => out.has(c.id));
    // One term's judge read fits; its second read and the other two terms'
    // reads do not. The one that was read keeps its approval: a refused
    // second read is no answer, not a no.
    expect(judged).toHaveLength(1);
    expect(out.get(judged[0].id)?.status).toBe("qualified");
    // Not judged is not refused: no verdict written for those terms at all.
    expect(keywordWrites).toHaveLength(judged.length);
    expect(run.claims.some((c) => c.granted === null)).toBe(true);
    expect(run.peak()).toBeLessThanOrEqual(ceiling + 1e-9);
    await new Promise((r) => setTimeout(r, 5));
    const billed = spend.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);
    expect(billed).toBeLessThanOrEqual(ceiling);
  });

  it("buys nothing at all when even the buyer test is refused", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { db, keywordWrites } = memoryDb();
    const out = await qualify(memoryBudget("run-3", 0.001), db);
    expect(out.size).toBe(0);
    expect(keywordWrites).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the plan's questions under a first look's budget", () => {
  const terms = ["acme booking cost", "acme booking setup"];
  const answer = JSON.stringify(Object.fromEntries(terms.map((t) => [t, ["What did your first setup cost you?", "Which step took you longest?"]])));

  it("are claimed and billed as their own stage", async () => {
    create.mockResolvedValue(reply(answer));
    const { db, spend } = memoryDb();
    const run = memoryBudget("run-q", 1);
    const out = await withSpendScope({ workspaceId: "ws-q", budget: run.budget, db }, () => generateQualityQuestionsBatch(terms, null));
    expect(out.size).toBe(2);
    expect(run.claims.map((c) => [c.stage, c.granted !== null])).toEqual([["questions", true]]);
    await vi.waitFor(() => expect(spend).toHaveLength(1));
    expect(spend[0]).toMatchObject({ provider: "anthropic", operation: "keywords/questions", workspace_id: "ws-q", run_id: "run-q", stage: "questions" });
  });

  it("are not asked when the budget refuses: no call, no questions, no failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, spend } = memoryDb();
    const run = memoryBudget("run-q2", 0.0001);
    const out = await withSpendScope({ workspaceId: "ws-q", budget: run.budget, db }, () => generateQualityQuestionsBatch(terms, null));
    expect(out.size).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(run.claims).toEqual([expect.objectContaining({ stage: "questions", granted: null })]);
    expect(spend).toEqual([]);
    warn.mockRestore();
  });

  it("carry no stage outside a first look: the tag is a budget's", async () => {
    create.mockResolvedValue(reply(answer));
    const { db, spend } = memoryDb();
    await withSpendScope({ workspaceId: "ws-q", db }, () => generateQualityQuestionsBatch(terms, null));
    await vi.waitFor(() => expect(spend).toHaveLength(1));
    expect(spend[0]).toMatchObject({ workspace_id: "ws-q", operation: "keywords/questions" });
    expect(spend[0].stage).toBeUndefined();
  });
});
