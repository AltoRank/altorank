// ---------------------------------------------------------------------------
// The production stall of 2026-10-15, replayed on the local database
// ---------------------------------------------------------------------------
//
// A real signup's re-run (after #286) reached qualification and then ran 25
// minutes without finishing. Its budget row at the kill: discovery $0.338 over
// 16 calls, voice $0.011, the buyer test $0.122 over 5 batches (the rest
// refused, leaving qualification its room), 6 results pages and 1 judge read
// settled - and 3 results pages and 4 judge reads granted and never settled.
// Two judge reads had written their spend rows; one of them never settled.
//
// This replays that run through the real pipeline - the run budget's claim
// and settle functions in Postgres, the real buyer test, recommender, refill,
// qualification and planner - with only the paid edges and the site replaced
// by stand-ins that claim, bill and take as long as the real ones do (scaled
// by STALL_LATENCY; 1 is production). It finishes when every call answers.
// What it could not survive is a call whose answer never comes: the requests
// in flight when the network dropped them (the "blip" below) are exactly the
// claims the production row held, and the run waited on them for good.
//
// Every bound is shortened (./time-limits.ts) so the test takes seconds.
// Seeds one account (acme-*.example) and deletes it at the end.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    phrases: [] as string[],
    /**
     * The run's seed. Each stand-in draws its latency from the seed and its
     * own input (\`h.draw(key)\`), never from a shared sequence: with one
     * sequence, whichever call arrived first took the next number, so a few
     * milliseconds of database jitter reassigned every later delay and the
     * replay judged 8 to 11 results pages from the same seed.
     */
    seed: 7,
    /** How many times each key has drawn, so a term's second judge read gets its own delay. */
    draws: {
      counts: new Map<string, number>(),
      next(key: string): number { const n = this.counts.get(key) ?? 0; this.counts.set(key, n + 1); return n; },
    },
    /** Real-time multiplier on every stand-in's latency (1 = production). */
    latency: Number(process.env.STALL_LATENCY ?? "0.05"),
    /**
     * The network dropping requests, as it did in production: armed, it opens
     * once the sixth results page has settled, and every budget settle and
     * model call sent while it is open gets no answer (it rejects only when
     * its own signal aborts, as a fetch on a dead socket does) until it has
     * swallowed `settles` settles and `models` model calls.
     */
    blip: { armed: false, open: false, pageSettles: 0, settles: 0, models: 0 },
    /** One verdict's save that never answers and that nothing can abort. */
    stuckSave: { armed: false, used: false },
    swallowed: [] as string[],
  };
  const realFetch = globalThis.fetch;
  const never = (signal: AbortSignal | null | undefined) => new Promise<Response>((_, reject) => {
    if (!signal) return;
    const abort = () => reject(signal.reason ?? Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.includes("/rpc/run_budget_settle")) {
      const b = state.blip;
      if (b.open && b.settles > 0) {
        b.settles -= 1;
        if (b.settles === 0 && b.models === 0) b.open = false;
        state.swallowed.push(`settle ${body}`);
        return never(init?.signal);
      }
      if (b.armed && !b.open && body.includes('"p_stage":"results_pages"') && ++b.pageSettles === 6) {
        b.armed = false;
        b.open = true;
      }
    }
    if (state.stuckSave.armed && !state.stuckSave.used && init?.method === "PATCH" && url.includes("/rest/v1/keywords") && body.includes('"opportunity"') && body.includes('"checkedAt"')) {
      state.stuckSave.used = true;
      state.swallowed.push(`save ${url}`);
      return never(null);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const api = { ...state, restoreFetch: () => { globalThis.fetch = realFetch; }, never,
    /** A number in [0, 1) fixed by the run's seed and the key, whatever order calls arrive in. */
    draw: (key: string): number => {
      let x = (api.seed ^ 0x9e3779b9) >>> 0;
      for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 0x01000193) >>> 0;
      x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0; x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0; x ^= x >>> 16;
      return x / 4294967296;
    },
  };
  return api;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * h.latency));

// Every bound scales with the stand-ins' latency, so a slower replay (a higher
// STALL_LATENCY) keeps the same proportions instead of tripping a deadline the
// fast one never reaches. At the default latency these are the values the
// cases were written against: 1s, 2s, 2s and 15s.
vi.mock("@/lib/onboarding/time-limits", async (original) => ({
  ...(await original<typeof import("@/lib/onboarding/time-limits")>()),
  // The budget RPCs go to a real local database, whose latency does not
  // shrink with the stand-ins': a loaded machine took over 1s for a claim,
  // which the replay then counted as a dropped call. 3s is a floor in real time.
  BUDGET_RPC_TIMEOUT_MS: Math.max(3_000, 20_000 * h.latency),
  STRUCTURED_CALL_DEADLINE_MS: 40_000 * h.latency,
  METERED_CALL_DEADLINE_MS: 40_000 * h.latency,
  // 15s at the default latency; STALL_QUALIFY_MS overrides it (production's is 150000).
  FIRST_LOOK_QUALIFY_MS: Number(process.env.STALL_QUALIFY_MS ?? 300_000 * h.latency),
}));
vi.mock("@/lib/domain/reachable", () => ({ checkDomainReachable: async () => ({ ok: true, verdict: "live", url: "https://acme.example" }) }));
vi.mock("../site-text", () => ({ readSiteText: async () => ({ text: "word ".repeat(200), source: "static", chars: 1000 }) }));
vi.mock("@/lib/voice/train", async () => {
  const { claimSpend } = await import("@/lib/billing/spend-scope");
  return { trainVoiceProfile: async () => { const c = await claimSpend("voice", 0.02); await c.settle(0.0109); } };
});
vi.mock("../site-assessment", () => ({ assessExistingPages: async () => ({ status: "done", detail: "Read 3 pages.", summary: null }) }));
vi.mock("@/lib/linking/detect", () => ({ detectLinks: async () => ({ found: 0, added: 0 }) }));
vi.mock("@/lib/content/generate", () => ({ generateArticle: async () => { throw new Error("the draft is dispatched, not written, in this test"); } }));
// The model, billed and timed as measured: a 40-phrase buyer-test batch
// $0.0244 in ~20s, a results-judge read ~$0.0104 in 4-9s.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async (p: { messages: Array<{ content: string | Array<{ text: string }> }>; max_tokens: number }, options?: { signal?: AbortSignal }) => {
        // The results judge sends its cached instructions and its data as two blocks.
        const content = p.messages[0].content;
        const prompt = typeof content === "string" ? content : content.map((b) => b.text).join("");
        const b = h.blip;
        if (b.open && b.models > 0) {
          b.models -= 1;
          if (b.settles === 0 && b.models === 0) b.open = false;
          h.swallowed.push("model call");
          await h.never(options?.signal);
        }
        const at = prompt.lastIndexOf("PHRASES\n");
        if (at !== -1) {
          await sleep(12_000 + h.draw(`buyer:${prompt.slice(at, at + 200)}`) * 12_000);
          const asked = JSON.parse(prompt.slice(at + "PHRASES\n".length)) as string[];
          // About two in three phrases are a served searcher.
          const text = JSON.stringify({ verdicts: asked.map((t, i) => ({ t, s: i % 3 === 2 ? "unrelated" : "solution", r: "a modeller choosing a kit" })) });
          return { content: [{ type: "text", text }], usage: { input_tokens: 2000, output_tokens: 51 * asked.length } };
        }
        if (prompt.includes('"results"')) {
          const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as { query: string; results: unknown[] };
          await sleep(4_000 + h.draw(`judge:${data.query}:${h.draws.next(`judge:${data.query}`)}`) * 5_000);
          // Most pages are articles; some are service pages; a few searchers are not served.
          const n = Number(data.query.match(/(\d+)$/)?.[1] ?? 0);
          const stage = n % 7 === 3 ? "elsewhere" : "solution";
          const kind = n % 5 === 1 ? "service" : "article";
          const text = JSON.stringify({ stage, kinds: data.results.map(() => kind), reason: "Modellers choosing a kit", audience: "railway modellers", buyingJob: "choose a kit", offering: "model railway kits", angle: `How to choose ${data.query}`, shape: "explainer", conversionPath: "https://acme.example" });
          return { content: [{ type: "text", text }], usage: { input_tokens: 3900, output_tokens: 260 } };
        }
        await sleep(1_000);
        return { content: [{ type: "text", text: "{}" }], usage: { input_tokens: 500, output_tokens: 50 } };
      },
    };
  },
}));
// DataForSEO: claims its estimate, bills half of it ($0.002 a results page), in 3-10s.
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
      await sleep(3_000 + h.draw(`dfs:${endpoint}:${body[0]?.keyword ?? ""}:${h.draws.next(`dfs:${endpoint}:${body[0]?.keyword ?? ""}`)}`) * 7_000);
      await claim.settle(estimate / 2);
      if (!endpoint.includes("/live/advanced")) return { cost: estimate / 2, tasks: [] };
      const keyword = body[0]?.keyword ?? "";
      const items = Array.from({ length: 10 }, (_, i) => ({ type: "organic", rank_group: i + 1, title: `${keyword}: a guide (${i + 1})`, url: `https://guide-${i}.example/${encodeURIComponent(keyword)}`, description: "A guide", domain: `guide-${i}.example` }));
      return { cost: estimate / 2, tasks: [{ result: [{ items }] }] };
    },
  };
});
// Discovery: its provider spend as measured ($0.338 over 16 calls), then the
// real buyer test over the whole pool, best first, then the kept phrases stored.
const discoveryClaims = vi.hoisted(() => [] as Array<{ wantUsd: number; minUsd: number }>);
vi.mock("@/lib/audit/domain-analysis", async () => {
  const { claimSpend, currentSpendScope, withSpendScope, withStage } = await import("@/lib/billing/spend-scope");
  const { judgeBuyerFit } = await import("@/lib/keyword-research/buyer-fit");
  return {
    analyseDomain: async (o: { supabase: import("@supabase/supabase-js").SupabaseClient; workspaceId: string; profile: Record<string, unknown> }) => {
      await Promise.all(Array.from({ length: 16 }, async (_, i) => {
        const c = await claimSpend("/dataforseo_labs/google/ranked_keywords/live", 0.022);
        await sleep(2_000 + h.draw(`discovery:${i}`) * 4_000);
        await c.settle(0.338 / 16);
      }));
      // The buyer test's claims as they reach the research budget, to show
      // they are sized (a floor below the most), not the full-batch estimate.
      const budget = currentSpendScope()!.budget!;
      const watched = { ...budget, claim: (stage: Parameters<typeof budget.claim>[0], want: number, min: number) => { if (stage === "buyer_fit") discoveryClaims.push({ wantUsd: want, minUsd: min }); return budget.claim(stage, want, min); } };
      const fit = await withSpendScope({ budget: watched }, () => withStage("buyer_fit", () => judgeBuyerFit({ ...o.profile, language: "en" }, h.phrases, { prioritized: true })));
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
import { FIRST_LOOK_DRAFT_RESERVE_USD, firstLookReserves, readRunBudget } from "@/lib/billing/run-budget";
import { firstLookTermUsd } from "@/lib/keyword-research/opportunity";
import type { OnboardingEvent } from "../events";

const STACK = await connectLocalStack();
const TAG = `b21-stall-${randomUUID().slice(0, 8)}`;
const BUSINESS = { name: "Acme Studio", description: "Acme Studio sells model railway kits and scenery to hobbyists.", offerings: ["model railway kits"], audiences: ["railway modellers"] };
/** Far past the shortened qualification deadline (15s): a run still going here never ends. */
const BOUND_MS = Math.max(60_000, 600_000 * h.latency);
/** Qualification's deadline as mocked above: 15s at the default latency. */
const QUALIFY_MS = Number(process.env.STALL_QUALIFY_MS ?? 300_000 * h.latency);

describe.skipIf(!STACK)("the 2026-10-15 first-look stall, replayed", () => {
  let db: ReturnType<typeof createServiceClient>;
  let accountId = "";
  let n = 0;

  /** A fresh site each time: its own pool, its own run, its own budget row. */
  async function firstLook(seed: number) {
    h.seed = seed;
    h.draws.counts.clear();
    const domain = `acme-${TAG}-${++n}.example`;
    const ws = await db.from("workspaces").insert({ account_id: accountId, name: domain, domain, initials: "AC", color: "av-c1", business_profile: BUSINESS, language: "en", location_code: 2840 }).select("id").single();
    if (ws.error || !ws.data) throw new Error(`workspaces: ${ws.error?.message}`);
    const workspaceId = ws.data.id as string;
    const { data: run, error } = await db.from("onboarding_runs").insert({ workspace_id: workspaceId, account_id: accountId }).select("id").single();
    if (error || !run) throw new Error(`onboarding_runs: ${error?.message}`);
    const events: Array<OnboardingEvent & { at: number }> = [];
    const started = Date.now();
    const done = runOnboarding(db, { id: workspaceId, domain, account_id: accountId, language: "en", location_code: 2840, business_profile: BUSINESS }, (e) => events.push({ ...e, at: Date.now() - started }), { firstDraft: "dispatch", runId: run.id as string });
    const outcome = await Promise.race([done, new Promise<"hung">((r) => setTimeout(() => r("hung"), BOUND_MS))]);
    const ms = Date.now() - started;
    if (process.env.STALL_TRACE) {
      const at = (phase: string, status: string) => events.find((e) => e.phase === phase && "status" in e && e.status === status)?.at;
      (await import("node:fs")).appendFileSync(process.env.STALL_TRACE, `run ${ms}ms; planning ${at("planning", "active")}ms -> ${[...events].reverse().find((e) => e.phase === "planning")?.at}ms; ${JSON.stringify(await readRunBudget(db, run.id as string))}\n`);
    }
    await db.from("onboarding_runs").update({ status: "done" }).eq("id", run.id);
    return { outcome, events, ms, budget: (await readRunBudget(db, run.id as string))! };
  }
  const last = (events: OnboardingEvent[], phase: string) => [...events].reverse().find((e) => e.phase === phase && "status" in e) as { status: string; detail?: string; planned?: unknown[]; at: number } | undefined;
  const first = (events: Array<OnboardingEvent & { at: number }>, phase: string, status: string) => events.find((e) => e.phase === phase && "status" in e && e.status === status);
  const settledEveryPhase = (events: OnboardingEvent[]) => {
    for (const phase of ["scanning", "keywords", "pages", "planning"]) expect(last(events, phase)?.status, phase).not.toBe("active");
  };

  beforeAll(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
    db = createServiceClient();
    const { data, error } = await db.from("accounts").insert({ name: `${TAG} account`, slug: TAG }).select("id").single();
    if (error || !data) throw new Error(`accounts: ${error?.message}`);
    accountId = data.id as string;
    h.phrases = Array.from({ length: 600 }, (_, i) => `model railway kit idea ${String(i).padStart(4, "0")}`);
  }, 30_000);

  beforeEach(() => {
    Object.assign(h.blip, { armed: false, open: false, pageSettles: 0, settles: 0, models: 0 });
    Object.assign(h.stuckSave, { armed: false, used: false });
    h.swallowed.length = 0;
    discoveryClaims.length = 0;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    h.restoreFetch();
    if (accountId) await db.from("accounts").delete().eq("id", accountId);
  }, 30_000);

  it("replays the production row up to qualification, finishes, and plans what the room allows", async () => {
    const { outcome, events, budget } = await firstLook(7);
    expect(outcome).not.toBe("hung");
    settledEveryPhase(events);
    // The research spent what production's did, and stopped where it did.
    expect(budget.stages.discovery).toMatchObject({ calls: 16 });
    expect(budget.stages.discovery?.spent).toBeCloseTo(0.338, 3);
    expect(budget.stages.buyer_fit?.calls).toBe(5);
    expect(budget.stages.buyer_fit?.spent).toBeCloseTo(0.122, 3);
    // Its buyer test asked with sized claims: a 40-phrase batch's most is
    // the $0.0855 the production log printed, and its floor is well below.
    const full = discoveryClaims.filter((c) => c.wantUsd > 0.08);
    expect(full.length).toBeGreaterThan(0);
    for (const c of full) expect(c.minUsd).toBeLessThan(c.wantUsd - 0.02);
    // Qualification judged with the room the research left, and planned.
    // How many terms that buys is not fixed: terms run side by side and a
    // term's second judge read claims when it lands, so the same seed reads
    // 8 to 11 results pages depending on when those reads arrive (production
    // read 9). What the start rule guarantees is that judging stops only
    // when the room left cannot start another term's whole chain.
    expect(budget.stages.results_pages?.calls ?? 0).toBeGreaterThanOrEqual(3);
    const reserved = Object.values(firstLookReserves(budget.ceilingUsd)).reduce((sum, usd) => sum + (usd ?? 0), 0);
    expect(budget.ceilingUsd - reserved - budget.committedUsd).toBeLessThan(firstLookTermUsd(true));
    expect(last(events, "planning")?.status).toBe("done");
    expect(last(events, "planning")?.planned?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(outcome !== "hung" && outcome.pendingDraft?.term).toBeTruthy();
    expect(budget.committedUsd).toBeLessThanOrEqual(1 - FIRST_LOOK_DRAFT_RESERVE_USD + 1e-6);
  }, BOUND_MS + 60_000);

  it("finishes when the network drops the calls production's row was left holding: 3 results pages' settles, 1 judge read's settle, 3 judge reads", async () => {
    h.blip.armed = true;
    h.blip.settles = 4;
    h.blip.models = 3;
    const { outcome, events, ms, budget } = await firstLook(7);
    expect(h.swallowed.length).toBe(7);
    expect(outcome).not.toBe("hung");
    settledEveryPhase(events);
    // Each dropped call ended at its own bound, well inside the stage's.
    const planning = first(events, "planning", "active")!.at;
    expect(last(events, "planning")!.at - planning).toBeLessThan(QUALIFY_MS);
    expect(ms).toBeLessThan(BOUND_MS);
    expect(last(events, "planning")?.status).toBe("done");
    expect(last(events, "planning")?.planned?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(outcome !== "hung" && outcome.pendingDraft?.term).toBeTruthy();
    // A settle that never answered leaves its claim at the estimate: the
    // safe side of the ceiling, never past it.
    expect(budget.committedUsd).toBeLessThanOrEqual(1 - FIRST_LOOK_DRAFT_RESERVE_USD + 1e-6);
  }, BOUND_MS + 60_000);

  it("ends qualification at its deadline when a call nothing can abort never answers, and still plans", async () => {
    h.stuckSave.armed = true;
    const { outcome, events, ms } = await firstLook(9);
    expect(h.swallowed).toHaveLength(1);
    expect(outcome).not.toBe("hung");
    settledEveryPhase(events);
    const planning = first(events, "planning", "active")!.at;
    const planned = last(events, "planning")!;
    // The stage's deadline (15s at the default latency), not the stuck call, decided when it ended.
    expect(planned.at - planning).toBeGreaterThanOrEqual(QUALIFY_MS - 20_000 * h.latency);
    expect(planned.at - planning).toBeLessThan(QUALIFY_MS + 200_000 * h.latency);
    expect(ms).toBeLessThan(BOUND_MS);
    expect(planned.status).toBe("done");
    expect(planned.planned?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(outcome !== "hung" && outcome.pendingDraft?.term).toBeTruthy();
  }, BOUND_MS + 60_000);
});
