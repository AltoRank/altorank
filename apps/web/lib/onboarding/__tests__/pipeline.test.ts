import { describe, it, expect, vi, beforeEach } from "vitest";

const scrape = vi.fn();
const voice = vi.fn();
const analyse = vi.fn();
const generate = vi.fn();
const quota = vi.fn();
const recommend = vi.fn();
const pick = vi.fn();
const creds = vi.fn();

// Reachability has its own tests; pipeline fixtures must not depend on public DNS.
vi.mock("@/lib/domain/reachable", () => ({
  checkDomainReachable: async () => ({ ok: true, verdict: "live", url: "https://example.com" }),
}));

vi.mock("../site-text", () => ({ readSiteText: async (...a: unknown[]) => { const text = (await scrape(...a)) as string; return { text, source: text ? "static" : "none", chars: text.length }; } }));
vi.mock("@/lib/voice/train", () => ({ trainVoiceProfile: (...a: unknown[]) => voice(...a) }));
vi.mock("@/lib/audit/domain-analysis", () => ({ analyseDomain: (...a: unknown[]) => analyse(...a) }));
vi.mock("@/lib/content/generate", () => ({ generateArticle: (...a: unknown[]) => generate(...a) }));
// Only getQuota is faked. The refusal message is real: it is counted off
// FREE_DRAFTS, and a stub would have hidden the drift this fixes.
vi.mock("@/lib/billing/quota", async () => {
  const real = await vi.importActual<typeof import("@/lib/billing/quota")>("@/lib/billing/quota");
  return { ...real, getQuota: (...a: unknown[]) => quota(...a) };
});
vi.mock("@/lib/seo/recommendations", () => ({
  recommendKeywords: (...a: unknown[]) => recommend(...a),
  pickNextKeyword: (...a: unknown[]) => pick(...a),
}));
vi.mock("@/lib/seo/client", () => ({
  hasDataForSEOCredentials: () => creds(),
}));
const recordSpendByDefault = vi.fn();
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: (e: unknown) => recordSpendByDefault(e), spendClient: () => null }));
const plan = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const held = vi.fn(async () => ({ count: 0, dates: [] as string[] }));
const scheduled = vi.fn(async () => 0);
vi.mock("../plan", () => ({ schedulePlan: (...a: unknown[]) => plan(...a), heldTopics: () => held(), countScheduled: () => scheduled(), fulfilPlannedEntry: vi.fn(async () => undefined) }));
// Whether the planner holds this account's calendar is the planner's own
// question (lib/billing/trial-hold.ts); the pipeline only words the screen
// from it. The draft-side predicate stays real.
// true/false are "held"/"open"; "spent" is passed as itself.
const planHold = vi.fn(async (): Promise<boolean | "open" | "held" | "spent"> => false);
vi.mock("@/lib/billing/trial-hold", async () => {
  const real = await vi.importActual<typeof import("@/lib/billing/trial-hold")>("@/lib/billing/trial-hold");
  const hold = async () => {
    const v = await planHold();
    return v === true ? "held" : v === false ? "open" : v;
  };
  return { ...real, planHold: hold, planHoldApplies: async () => (await hold()) !== "open" };
});
// Whether a judge could run this time; the empty pool is only read when one could.
const model = vi.fn(() => true);
vi.mock("@/lib/keyword-research/buyer-model", async () => {
  const real = await vi.importActual<typeof import("@/lib/keyword-research/buyer-model")>("@/lib/keyword-research/buyer-model");
  return { ...real, modelAvailable: () => model() };
});
const fanOut = vi.fn(() => ({ dispatched: 0, settled: Promise.resolve() }));
vi.mock("@/lib/content/fan-out", async () => {
  const real = await vi.importActual<typeof import("@/lib/content/fan-out")>("@/lib/content/fan-out");
  return { ...real, fanOutDrafts: (...a: unknown[]) => fanOut(...(a as [])) };
});
// The week's related keywords, bought in one task before any draft is
// dispatched. Faked here because the real one is a paid provider call; what
// this suite pins is that it is called once and its rows reach the drafts.
const relatedBatch = vi.fn(async (_terms: string[], _locale: unknown) => new Map<string, unknown[]>());
vi.mock("@/lib/seo/brief-data", () => ({
  fetchRelatedKeywordsBatch: (terms: string[], locale: unknown) => relatedBatch(terms, locale),
}));
const detect = vi.fn(async () => ({ found: 0, added: 0 }));
vi.mock("@/lib/linking/detect", () => ({ detectLinks: (...a: unknown[]) => detect(...(a as [])) }));
// Mocked, and it has to be: the real one fetches robots.txt, a sitemap and up
// to forty pages of whatever domain the fixture names. A unit test that
// reaches the network is a unit test that fails on a train.
const assess = vi.fn(async () => ({ status: "done" as const, detail: "Read 12 pages. Found 30 technical issues on 9 of them.", summary: null }));
vi.mock("../site-assessment", () => ({ assessExistingPages: (...a: unknown[]) => assess(...(a as [])) }));

// The funnel event's shape is tested on its own (funnel-event.test.ts); here
// only that every run hands it over, and with what.
const recordFunnel = vi.fn(async (_e: unknown) => undefined);
vi.mock("../funnel-event", () => ({ recordPlanFunnel: (e: unknown) => recordFunnel(e) }));
// The tally itself is tested on its own (empty-pool.test.ts) and against a
// real database (run-store.db.test.ts); here the question is when the
// pipeline asks for it and where it puts the answer.
const EMPTY_POOL = { stage: "qualification" as const, cause: "buyer_mismatch", keywords: 94, qualified: 0, rejected: { buyer_mismatch: 94 }, pending: {}, summary: "None of 94 searches qualified." };
const emptyPool = vi.fn(async (..._a: unknown[]) => EMPTY_POOL);
vi.mock("../empty-pool", () => ({ readEmptyPool: (...a: unknown[]) => emptyPool(...a) }));

import { runOnboarding } from "../pipeline";
import { BudgetRefusedError, currentSpendScope } from "@/lib/billing/spend-scope";
import type { OnboardingEvent } from "../events";

const WS = { id: "ws1", domain: "example.com", account_id: "ag1", language: "en" };
const NEXT = { term: "seo agent", reasons: ["27,100 searches/mo"], score: 35.5, difficulty: 19, volume: 27100 };

/** Enough client for the "already has a draft?" count. */
const client = (existing: number) =>
  ({ from: () => ({ select: () => ({ or: () => ({ eq: async () => ({ count: existing }) }) }) }) }) as never;

async function collect(existing = 0): Promise<OnboardingEvent[]> {
  const events: OnboardingEvent[] = [];
  await runOnboarding(client(existing), WS, (e) => events.push(e));
  return events;
}

/** The worker's mode: the draft is chosen here and written elsewhere. */
async function collectDispatch(c: never = richClient(0)) {
  const events: OnboardingEvent[] = [];
  const result = await runOnboarding(c, WS, (e) => events.push(e), { firstDraft: "dispatch" });
  return { events, result };
}

const phases = (events: OnboardingEvent[]) =>
  events.map((e) => ("status" in e ? `${e.phase}:${e.status}` : e.phase));

/**
 * A client that answers the whole run, not just the "already has a draft?"
 * count: the fan-out reads calendar_entries too, and a thin mock made that
 * branch untestable.
 */
const chain = (result: Record<string, unknown>): never => {
  const self: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => void) => res(result);
      return () => self;
    },
  });
  return self as never;
};
const richClient = (existing: number) =>
  ({ from: (table: string) => (table === "articles" ? chain({ count: existing }) : chain({ data: [] })) }) as never;

beforeEach(() => {
  for (const m of [scrape, voice, analyse, generate, quota, recommend, pick, creds, recordSpendByDefault]) m.mockReset();
  fanOut.mockReset();
  fanOut.mockReturnValue({ dispatched: 0, settled: Promise.resolve() });
  relatedBatch.mockReset();
  relatedBatch.mockResolvedValue(new Map());
  detect.mockReset();
  detect.mockResolvedValue({ found: 0, added: 0 });
  assess.mockReset();
  assess.mockResolvedValue({ status: "done", detail: "Read 12 pages. Found 30 technical issues on 9 of them.", summary: null });
  // Both of these are set per-test by the fan-out cases, and a leak into the
  // thin client below shows up as "not is not a function" three tests later.
  plan.mockReset();
  plan.mockResolvedValue([]);
  scrape.mockResolvedValue("word ".repeat(80));
  voice.mockResolvedValue(undefined);
  creds.mockReturnValue(true);
  // `layers` is read now: the keywords phase quotes analyseDomain's own
  // reason when nothing was stored, so "we could not read your site" is not
  // reported as "nothing rankable found".
  analyse.mockResolvedValue({ keywordsFound: 94, layers: [] });
  quota.mockResolvedValue({ limit: 1, used: 0, remaining: 1, reason: "no-plan" });
  recommend.mockResolvedValue([NEXT]);
  pick.mockReturnValue(NEXT);
  generate.mockResolvedValue({
    articleId: "a1", title: "What an SEO agent does", wordCount: 1200,
    factCheck: { verdict: "clean" },
  });
});

describe("runOnboarding", () => {
  it("fills the link pool from the site's own sources before the first draft is written", async () => {
    const order: string[] = [];
    detect.mockImplementation(async () => { order.push("detect"); return { found: 28, added: 28 }; });
    generate.mockImplementation(async () => {
      order.push("generate");
      return { articleId: "a1", title: "T", wordCount: 1200, factCheck: { verdict: "clean" } };
    });
    await collect();
    expect(order).toEqual(["detect", "generate"]);
    expect(detect).toHaveBeenCalledWith(expect.anything(), "ws1");
  });

  it("still writes the draft when the sitemap cannot be read", async () => {
    detect.mockRejectedValue(new Error("Could not fetch the sitemap."));
    const events = await collect();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(phases(events)).toContain("drafting:done");
  });

  it("does not look for a link pool when there is no domain", async () => {
    await runOnboarding(client(0), { ...WS, domain: null }, () => undefined);
    expect(detect).not.toHaveBeenCalled();
  });

  /**
   * Through the client it was handed, never through the server action: the
   * worker has no session, and the action's requireAuth failed every run's
   * first phase with "Not authenticated" until this was the rule.
   */
  it("trains the voice through the client it was given", async () => {
    const c = client(0);
    await runOnboarding(c, WS, () => undefined);
    expect(voice).toHaveBeenCalledWith(c, "ws1", expect.stringContaining("word"));
  });

  it("emits every boundary of a full run, in order, ending in ready", async () => {
    const events = await collect();
    expect(phases(events)).toEqual([
      "scanning:active", "scanning:done",
      "keywords:active", "keywords:done",
      "pages:active", "pages:done",
      "planning:active", "planning:skipped",
      "drafting:active", "drafting:done",
      "ready",
    ]);
    const done = events.find((e) => e.phase === "drafting" && "status" in e && e.status === "done");
    expect(done).toMatchObject({ article: { id: "a1", keyword: "seo agent", wordCount: 1200, verdict: "clean" } });
    expect(events.find((e) => e.phase === "keywords" && "keywordsFound" in e)).toMatchObject({ keywordsFound: 94 });
  });

  /**
   * The reliability fix in one assertion: the draft is awaited inside the run,
   * so by the time `ready` is emitted it has been written. The old after()
   * version returned before generateArticle ran at all.
   */
  it("has written the draft before it says ready", async () => {
    const order: string[] = [];
    generate.mockImplementation(async () => { order.push("generate"); return { articleId: "a1", title: "T", wordCount: 1, factCheck: { verdict: "clean" } }; });
    await runOnboarding(client(0), WS, (e) => { if (e.phase === "ready") order.push("ready"); });
    expect(order).toEqual(["generate", "ready"]);
  });

  /**
   * The longest silence in the run is the model writing. onResearch is the one
   * boundary inside it, and it must surface as the same phase still active -
   * a progress note, not a second start and not a premature done.
   */
  it("reports research inside the draft phase without changing its status", async () => {
    generate.mockImplementation(async (opts: { onResearch?: (r: unknown) => void }) => {
      opts.onResearch?.({ competitors: [1, 2, 3], peopleAlsoAsk: [1, 2] });
      return { articleId: "a1", title: "T", wordCount: 900, factCheck: { verdict: "review" } };
    });
    const events = await collect();
    const drafting = events.filter((e) => e.phase === "drafting");
    expect(phases(drafting)).toEqual(["drafting:active", "drafting:active", "drafting:done"]);
    expect(drafting[1]).toMatchObject({ detail: expect.stringMatching(/3 ranking pages.*2 questions/) });
  });

  /**
   * FREE_DRAFTS went 1 -> 7 on 2026-09-06 and this message still said "your
   * free draft". It is counted off the quota's own limit now, so it cannot
   * drift again. It named a reset date until 2026-09-07; the allowance is
   * one-time since migration 083, so it no longer does.
   */
  it("skips the draft, and does not fail the run, when the budget refuses a claim part-way through it", async () => {
    generate.mockRejectedValue(new BudgetRefusedError("claude-sonnet-5", "draft", 0.42));
    const events = await collect();
    const drafting = events.find((e) => e.phase === "drafting" && "status" in e && e.status !== "active");
    expect(drafting).toMatchObject({ status: "skipped" });
    expect((drafting as { detail: string }).detail).toContain("A person picks the first article up.");
    expect(events.some((e) => "status" in e && e.status === "failed")).toBe(false);
    expect(events.at(-1)).toEqual({ phase: "ready" });
  });

  it("skips the draft, with the reason, when the free allowance is used", async () => {
    quota.mockResolvedValue({ limit: 7, used: 7, remaining: 0, reason: "no-plan" });
    const events = await collect();
    expect(generate).not.toHaveBeenCalled();
    expect(events.find((e) => e.phase === "drafting" && "status" in e && e.status !== "active"))
      .toMatchObject({
        status: "skipped",
        // `quotaExceededMessage` verbatim: this used to be a second copy of
        // that sentence, and the paid half of it drifted into telling a paid
        // account at its limit to upgrade "to keep drafting" - which is not
        // what happens, since the next one bills as overage.
        detail:
          "All 7 free drafts are used. Choose a plan on the Billing page to keep going, or self-host AltoRank free.",
      });
    expect(events.at(-1)).toEqual({ phase: "ready" });
  });

  it("says \"is\" for an allowance of one and names the plan's volume for a paid account", async () => {
    quota.mockResolvedValue({ limit: 1, used: 1, remaining: 0, reason: "no-plan" });
    const one = await collect();
    expect(one.find((e) => e.phase === "drafting" && "status" in e && e.status === "skipped"))
      .toMatchObject({ detail: expect.stringContaining("All 1 free draft is used") });

    quota.mockResolvedValue({ limit: 100, used: 100, remaining: 0, reason: "plan", plan: "starter" });
    const paid = await collect();
    expect(paid.find((e) => e.phase === "drafting" && "status" in e && e.status === "skipped"))
      .toMatchObject({ detail: expect.stringContaining("This month's included 100 articles are used") });
    expect(paid.find((e) => e.phase === "drafting" && "status" in e && e.status === "skipped"))
      .toMatchObject({ detail: expect.stringContaining("write one by hand") });
  });

  /**
   * The fan-out note used to be emitted as `drafting:active`, which reset the
   * finished step to a spinner and replaced "Wrote 1,200 words on X" with a
   * sentence about the other six. It is a note, so it carries the status the
   * phase already settled on.
   */
  it("announces that the rest of the week waits for the person, and does not write it", async () => {
    plan.mockResolvedValue([
      { term: "seo agent", date: "2026-09-07", keywordId: "k1" },
      { term: "seo tools", date: "2026-09-08", keywordId: "k2" },
    ]);
    const events: OnboardingEvent[] = [];
    await runOnboarding(richClient(0), WS, (e) => events.push(e));
    const last = events.filter((e) => e.phase === "drafting").at(-1);
    expect(last).toMatchObject({ status: "done" });
    expect((last as { detail: string }).detail).toBe(
      'Wrote 1,200 words on "seo agent". 1 more article is planned. They start once you have read this one.',
    );
    expect(fanOut).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ phase: "ready" });
  });

  it("keeps a skipped draft skipped, with no note about a week that is not coming", async () => {
    plan.mockResolvedValue([
      { term: "seo agent", date: "2026-09-07", keywordId: "k1" },
      { term: "seo tools", date: "2026-09-08", keywordId: "k2" },
    ]);
    pick.mockReturnValue(null);
    recommend.mockResolvedValue([]);
    const events: OnboardingEvent[] = [];
    await runOnboarding(richClient(0), WS, (e) => events.push(e));
    expect(events.filter((e) => e.phase === "drafting").at(-1)).toMatchObject({ status: "skipped" });
    expect(fanOut).not.toHaveBeenCalled();
  });

  it("does not write a second draft into a workspace that has one", async () => {
    const events = await collect(1);
    expect(generate).not.toHaveBeenCalled();
    expect(phases(events)).toContain("drafting:skipped");
  });

  /** One phase breaking must not cost the account the phases after it. */
  it("continues to the draft when keyword analysis throws", async () => {
    analyse.mockRejectedValue(new Error("DataForSEO 40101"));
    const events = await collect();
    expect(phases(events)).toEqual([
      "scanning:active", "scanning:done",
      "keywords:active", "keywords:failed",
      "pages:active", "pages:done",
      "planning:active", "planning:skipped",
      "drafting:active", "drafting:done",
      "ready",
    ]);
    expect(events.find((e) => e.phase === "keywords" && "detail" in e)).toMatchObject({ detail: "DataForSEO 40101" });
  });

  it("skips voice when the site has too little text, and keeps going", async () => {
    scrape.mockResolvedValue("just a few words");
    const events = await collect();
    expect(voice).not.toHaveBeenCalled();
    expect(phases(events)[1]).toBe("scanning:skipped");
    expect(events.at(-1)).toEqual({ phase: "ready" });
  });

  it("skips keyword research on an install without DataForSEO", async () => {
    creds.mockReturnValue(false);
    const events = await collect();
    expect(analyse).not.toHaveBeenCalled();
    expect(phases(events)).toContain("keywords:skipped");
  });

  /**
   * Discovery is the expensive phase and it ran with no reporter armed, so its
   * DataForSEO rows fell through to the unattributed default: fourteen rows
   * from one onboarding, none with a workspace_id. Then the reporter was a
   * process global, and a concurrent run billed this one's calls. Every call
   * in the run now sees the run's spend scope - its workspace, and the stage
   * it is in - and nothing outside the run does.
   */
  it("attributes every call in the run to the workspace and its stage, and nothing outside the run", async () => {
    const seen: Array<ReturnType<typeof currentSpendScope>> = [];
    scrape.mockImplementation(async () => { seen.push(currentSpendScope()); return "word ".repeat(80); });
    voice.mockImplementation(async () => { seen.push(currentSpendScope()); });
    analyse.mockImplementation(async () => { seen.push(currentSpendScope()); return { keywordsFound: 0, layers: [] }; });
    await collect();
    expect(seen.map((s) => [s?.workspaceId, s?.stage])).toEqual([["ws1", "voice"], ["ws1", "voice"], ["ws1", "discovery"]]);
    expect(currentSpendScope()).toBeUndefined();
  });

  it("skips everything that needs a domain when there is none", async () => {
    const events: OnboardingEvent[] = [];
    await runOnboarding(client(0), { ...WS, domain: null }, (e) => events.push(e));
    expect(scrape).not.toHaveBeenCalled();
    expect(analyse).not.toHaveBeenCalled();
    expect(phases(events).slice(0, 4)).toEqual(["scanning:active", "scanning:skipped", "keywords:active", "keywords:skipped"]);
  });

  /**
   * Under the worker the draft is not written here. The phase is left
   * `active` with the keyword named, `ready` is not emitted - the draft route
   * settles the row - and the caller gets the keyword and its gates' verdict
   * back to dispatch after its final write.
   */
  describe("firstDraft: dispatch", () => {
    it("chooses and gates the draft, returns it, and does not write or say ready", async () => {
      const { events, result } = await collectDispatch();
      expect(generate).not.toHaveBeenCalled();
      expect(result.pendingDraft).toEqual({
        term: "seo agent",
        keywordId: null,
        selection: { reasons: ["27,100 searches/mo"], score: 35.5, difficulty: 19, volume: 27100 },
      });
      expect(phases(events)).toEqual([
        "scanning:active", "scanning:done",
        "keywords:active", "keywords:done",
        "pages:active", "pages:done",
        "planning:active", "planning:skipped",
        "drafting:active", "drafting:active",
      ]);
      expect(events.at(-1)).toMatchObject({ detail: 'Writing "seo agent" now. It lands in your review queue when it is done.' });
    });

    it("still says ready when there is no draft to dispatch", async () => {
      pick.mockReturnValue(null);
      recommend.mockResolvedValue([]);
      const { events, result } = await collectDispatch();
      expect(result.pendingDraft).toBeNull();
      expect(phases(events)).toContain("drafting:skipped");
      expect(events.at(-1)).toEqual({ phase: "ready" });
    });

    it("gates the dispatched draft on the quota, with the same sentence", async () => {
      quota.mockResolvedValue({ limit: 7, used: 7, remaining: 0, reason: "no-plan" });
      const { events, result } = await collectDispatch();
      expect(result.pendingDraft).toBeNull();
      expect(events.find((e) => e.phase === "drafting" && "status" in e && e.status === "skipped"))
        .toMatchObject({ detail: expect.stringContaining("All 7 free drafts are used") });
      expect(events.at(-1)).toEqual({ phase: "ready" });
    });

    /**
     * The first draft has no article yet when the fan-out is computed, so its
     * plan entry still reads as unwritten; without this it would be dispatched
     * twice - once as the first draft, once as "the rest of the week".
     */
    /**
     * `keywords_for_keywords` is billed per task and takes twenty seeds. Seven
     * drafts each buying their own was $0.63 of a measured $1.929 signup
     * (round4 §4, W2), so the run buys the week once and carries each draft's
     * share to the invocation that writes it.
     */
    it("buys related keywords for the one draft it writes, not for the week", async () => {
      plan.mockResolvedValue([
        { term: "seo agent", date: "2026-09-07", keywordId: "k1" },
        { term: "seo tools", date: "2026-09-08", keywordId: "k2" },
      ]);
      recommend.mockResolvedValue([{ ...NEXT, keywordId: "k1" }]);
      relatedBatch.mockResolvedValue(new Map([["seo agent", [{ keyword: "seo agents", searchVolume: 100, competition: null }]]]));
      const { result } = await collectDispatch();
      expect(relatedBatch).toHaveBeenCalledTimes(1);
      expect(relatedBatch.mock.calls[0][0]).toEqual(["seo agent"]);
      expect(result.pendingDraft?.relatedKeywords).toEqual([{ keyword: "seo agents", searchVolume: 100, competition: null }]);
      expect(fanOut).not.toHaveBeenCalled();
    });

    it("carries on when the shared lookup fails: each draft buys its own, as before", async () => {
      plan.mockResolvedValue([{ term: "seo agent", date: "2026-09-07", keywordId: "k1" }]);
      recommend.mockResolvedValue([{ ...NEXT, keywordId: "k1" }]);
      relatedBatch.mockRejectedValue(new Error("rate limited"));
      const { result } = await collectDispatch();
      expect(result.pendingDraft?.term).toBe("seo agent");
      expect(result.pendingDraft?.relatedKeywords).toBeUndefined();
    });

    it("dispatches exactly one draft, the first", async () => {
      plan.mockResolvedValue([
        { term: "seo agent", date: "2026-09-07", keywordId: "k1" },
        { term: "seo tools", date: "2026-09-08", keywordId: "k2" },
      ]);
      recommend.mockResolvedValue([{ ...NEXT, keywordId: "k1" }]);
      const { result } = await collectDispatch();
      expect(result.pendingDraft?.keywordId).toBe("k1");
      expect(fanOut).not.toHaveBeenCalled();
    });

    it("tells the still-active draft that the rest waits", async () => {
      plan.mockResolvedValue([
        { term: "seo agent", date: "2026-09-07", keywordId: "k1" },
        { term: "seo tools", date: "2026-09-08", keywordId: "k2" },
      ]);
      recommend.mockResolvedValue([{ ...NEXT, keywordId: "k1" }]);
      const { events } = await collectDispatch();
      const last = events.filter((e) => e.phase === "drafting").at(-1) as { detail?: string };
      expect(last.detail).toContain("start once you have read this one");
      expect(fanOut).not.toHaveBeenCalled();
    });
  });
});

describe("the trial gate and the first plan", () => {
  beforeEach(() => {
    planHold.mockReset().mockResolvedValue(false);
    scheduled.mockReset().mockResolvedValue(0);
  });
  it("reports what the trial opens, for an account that will be asked for a card", async () => {
    planHold.mockResolvedValue(true);
    quota.mockResolvedValue({ limit: 7, used: 0, remaining: 7, reason: "no-plan", trialEligible: true });
    plan.mockResolvedValue([{ keywordId: "k1", term: "seo agent", date: "2026-09-21" }]);
    held.mockResolvedValue({ count: 3, dates: ["2026-09-23", "2026-09-25", "2026-09-27"] });
    const events = await collect();
    const planning = events.find((e) => e.phase === "planning" && e.status === "done") as { detail?: string };
    // The cap is the planner's (it plans the one article for a held account
    // whatever it is asked for); the pipeline no longer passes a hold.
    expect(plan.mock.calls[0][3]).toMatchObject({ maxEntries: 5 });
    expect(planning.detail).toContain("Scheduled your first article. 3 more topics are ready");
  });
  it("plans the month for everyone else", async () => {
    held.mockClear();
    quota.mockResolvedValue({ limit: null, used: 0, remaining: null, reason: "self-host" });
    plan.mockResolvedValue([{ keywordId: "k1", term: "seo agent", date: "2026-09-21" }]);
    await collect();
    expect(plan.mock.calls[0][3]).toMatchObject({ maxEntries: 5 });
    expect(held).not.toHaveBeenCalled();
  });
  it("says the first article is already planned when a held account runs again, not that nothing qualifies", async () => {
    planHold.mockResolvedValue(true);
    scheduled.mockResolvedValue(1);
    quota.mockResolvedValue({ limit: 7, used: 1, remaining: 6, reason: "no-plan", trialEligible: true });
    plan.mockResolvedValue([]);
    const events = await collect();
    const planning = events.filter((e) => e.phase === "planning").at(-1) as { status: string; detail?: string };
    expect(planning.status).toBe("skipped");
    expect(planning.detail).toContain("Your first article is already on the calendar; the rest of the plan opens with the trial.");
    // That site has a plan: it is not an empty pool.
    expect(planning).not.toHaveProperty("emptyPool");
  });
  it("writes nothing more for a held account that already has its article, and buys no research for it", async () => {
    quota.mockResolvedValue({ limit: 7, used: 1, remaining: 6, reason: "no-plan", trialEligible: true });
    plan.mockResolvedValue([]);
    const events = await collect();
    const drafting = events.filter((e) => e.phase === "drafting").at(-1) as { status: string; detail?: string };
    expect(drafting.status).toBe("skipped");
    expect(drafting.detail).toMatch(/^Waiting for your trial to start\./);
    expect(recommend).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
  it("still writes the first article of a held account", async () => {
    quota.mockResolvedValue({ limit: 7, used: 0, remaining: 7, reason: "no-plan", trialEligible: true });
    plan.mockResolvedValue([]);
    recommend.mockResolvedValue([{ term: "seo agent", keywordId: "k1", action: "write", quality: "ok", reasons: ["r"], score: 1, difficulty: 1, volume: 10 }]);
    pick.mockImplementation((recs: unknown[]) => recs[0]);
    generate.mockResolvedValue({ articleId: "a1", title: "T", wordCount: 900, factCheck: { verdict: "clean" } });
    await collect();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("writes nothing for a site added after the trial was cancelled, and buys no research for it", async () => {
    const TRIAL_END = "2026-10-06T12:00:00.000Z";
    quota.mockResolvedValue({ limit: 100, used: 5, remaining: 95, reason: "plan", plan: "starter", trial: { endsAt: TRIAL_END, daysLeft: 5, cancelsAt: TRIAL_END } });
    plan.mockResolvedValue([]);
    const events = await collect();
    const drafting = events.filter((e) => e.phase === "drafting").at(-1) as { status: string; detail?: string };
    expect(drafting.status).toBe("skipped");
    expect(drafting.detail).toMatch(/^Your trial is cancelled, so nothing new is drafted\./);
    expect(recommend).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("runOnboarding: the topic funnel", () => {
  const FUNNEL = { found: 12, removed: { buyer_fit: 8, not_editorial: 2 }, qualified: 2, planned: 1, judged: 4 };
  beforeEach(() => recordFunnel.mockReset());

  it("writes down the funnel the planner reported, with the run and the account", async () => {
    plan.mockImplementation(async (...a: unknown[]) => {
      (a[3] as { onFunnel?: (f: unknown) => void }).onFunnel?.(FUNNEL);
      return [];
    });
    // The run's budget row, as the worker opened it and the run spent it.
    const ROW = { ceiling_usd: 1, committed_usd: 0.42, refused: 2, stages: { discovery: { spent: 0.3, calls: 5, committed: 0.3 }, judge: { spent: 0.12, calls: 4, refused: 2, committed: 0.12 } } };
    const opened: unknown[] = [];
    const base = richClient(0) as unknown as { from: (t: string) => unknown };
    const budgetTable = {
      upsert: async (row: unknown) => { opened.push(row); return { error: null }; },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: ROW, error: null }) }) }),
    };
    const db = { from: (t: string) => (t === "run_budgets" ? budgetTable : base.from(t)), rpc: async () => ({ data: 0.01, error: null }) } as never;
    await runOnboarding(db, WS, () => undefined, { firstDraft: "dispatch", runId: "run-9" });
    expect(opened).toEqual([{ run_id: "run-9", workspace_id: "ws1", ceiling_usd: 1, reserves: { draft: 0.3, outline_swap: 0.05 } }]);
    expect(recordFunnel).toHaveBeenCalledOnce();
    expect(recordFunnel).toHaveBeenCalledWith({
      runId: "run-9", workspaceId: "ws1", accountId: "ag1", funnel: FUNNEL,
      planningDetail: "No keyword clear enough to plan yet.",
      spend: { ceilingUsd: 1, committedUsd: 0.42, refused: 2, stages: { discovery: { spent: 0.3, calls: 5, committed: 0.3, refused: 0 }, judge: { spent: 0.12, calls: 4, refused: 2, committed: 0.12 } } },
    });
  });

  it("still writes it when the planner throws after counting, with the failure as the reason", async () => {
    plan.mockImplementation(async (...a: unknown[]) => {
      (a[3] as { onFunnel?: (f: unknown) => void }).onFunnel?.({ ...FUNNEL, planned: 0 });
      throw new Error("Start your trial to keep going.");
    });
    await runOnboarding(richClient(0), WS, () => undefined, { firstDraft: "dispatch" });
    expect(recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ runId: null, funnel: { ...FUNNEL, planned: 0 }, planningDetail: "Start your trial to keep going." }));
  });

  it("writes a run with no keywords as one the planner never read", async () => {
    analyse.mockResolvedValue({ keywordsFound: 0, layers: [] });
    await runOnboarding(richClient(0), WS, () => undefined, { firstDraft: "dispatch" });
    expect(plan).not.toHaveBeenCalled();
    expect(recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ funnel: null, planningDetail: "Nothing to schedule until there are keywords." }));
  });
});

// A first look that ran and found nothing clear enough: the planning event
// carries which stage emptied the pool, which is what makes the run
// `nothing_planned` rather than a setup that fell short (2026-09-28).
describe("the empty pool", () => {
  beforeEach(() => {
    emptyPool.mockClear();
    planHold.mockReset().mockResolvedValue(false);
    scheduled.mockReset().mockResolvedValue(0);
  });
  const planningEvent = (events: OnboardingEvent[]) => events.filter((e) => e.phase === "planning").at(-1) as { status: string; emptyPool?: unknown };

  it("is attached to the planning event when keywords were found and none was planned", async () => {
    plan.mockResolvedValue([]);
    const events = await collect();
    expect(planningEvent(events)).toMatchObject({ status: "skipped", emptyPool: EMPTY_POOL });
    expect(emptyPool).toHaveBeenCalledWith(expect.anything(), "ws1");
  });

  it("is not read when the plan has something on it", async () => {
    plan.mockResolvedValue([{ keywordId: "k1", term: "seo agent", date: "2026-09-21" }]);
    const events = await collect();
    expect(planningEvent(events)).not.toHaveProperty("emptyPool");
    expect(emptyPool).not.toHaveBeenCalled();
  });

  it("is attached when research looked and found nothing", async () => {
    analyse.mockResolvedValue({ keywordsFound: 0, layers: [] });
    const events = await collect();
    expect(planningEvent(events)).toMatchObject({ status: "skipped", emptyPool: EMPTY_POOL });
  });

  it("is not attached when the site could not be read: that setup fell short", async () => {
    analyse.mockResolvedValue({ keywordsFound: 0, layers: [{ id: "crawl", status: "failed", detail: "HTTP 403" }] });
    const events = await collect();
    expect(planningEvent(events)).not.toHaveProperty("emptyPool");
    expect(emptyPool).not.toHaveBeenCalled();
  });

  it("is not attached when keyword research is not configured", async () => {
    creds.mockReturnValue(false);
    const events = await collect();
    expect(planningEvent(events)).not.toHaveProperty("emptyPool");
  });

  it("is not read when no model could judge this run: old verdicts are not this run's answer", async () => {
    plan.mockResolvedValue([]);
    model.mockReturnValueOnce(false);
    const events = await collect();
    expect(planningEvent(events)).toMatchObject({ status: "skipped" });
    expect(planningEvent(events)).not.toHaveProperty("emptyPool");
    expect(emptyPool).not.toHaveBeenCalled();
  });

  it("is not read when the trial hold, not the pool, emptied the plan (the pre-trial article is spent)", async () => {
    plan.mockResolvedValue([]);
    planHold.mockResolvedValue("spent");
    const events = await collect();
    expect(planningEvent(events)).not.toHaveProperty("emptyPool");
    expect(emptyPool).not.toHaveBeenCalled();
  });

  it("leaves the run as it was when the tally cannot be read", async () => {
    plan.mockResolvedValue([]);
    emptyPool.mockRejectedValueOnce(new Error("keywords read failed"));
    const events = await collect();
    expect(planningEvent(events)).toMatchObject({ status: "skipped" });
    expect(planningEvent(events)).not.toHaveProperty("emptyPool");
  });
});
