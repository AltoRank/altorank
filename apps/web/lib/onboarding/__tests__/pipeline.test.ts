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
const setSpendReporter = vi.fn();
vi.mock("@/lib/seo/client", () => ({
  hasDataForSEOCredentials: () => creds(),
  setSpendReporter: (fn: unknown) => setSpendReporter(fn),
}));
const recordSpendByDefault = vi.fn();
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: (e: unknown) => recordSpendByDefault(e) }));
const plan = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const held = vi.fn(async () => ({ count: 0, dates: [] as string[] }));
const scheduled = vi.fn(async () => 0);
// Planned entries carry the verdict they were planned on, as the planner's
// do: an approval of value 2 on an article page, which the first-article
// rule accepts, unless a test says otherwise.
vi.mock("../plan", () => ({ schedulePlan: async (...a: unknown[]) => ((await plan(...a)) as Array<Record<string, unknown>>).map((e) => ({ brief: BRIEF, ...e })), heldTopics: () => held(), countScheduled: () => scheduled(), fulfilPlannedEntry: vi.fn(async () => undefined) }));
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
const emptyPool = vi.fn(async (..._a: unknown[]): Promise<EmptyPool> => EMPTY_POOL);
vi.mock("../empty-pool", async (original) => ({ ...(await original<object>()), readEmptyPool: (...a: unknown[]) => emptyPool(...a) }));
const announceNoFirst = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../first-article-ops", () => ({ announceNoFirstArticle: (...a: unknown[]) => announceNoFirst(...a) }));

import { runOnboarding } from "../pipeline";
import type { EmptyPool, OnboardingEvent } from "../events";

const WS = { id: "ws1", domain: "example.com", account_id: "ag1", language: "en" };
const BRIEF = { version: 2, context: "c", checkedAt: "2026-09-30T00:00:00.000Z", status: "qualified", reason: "a founder choosing a tool", format: "article", value: 2, angle: "What an SEO agent does", buyingJob: "choose a tool" };
const NEXT = { term: "seo agent", reasons: ["27,100 searches/mo"], score: 35.5, difficulty: 19, volume: 27100, action: "write", quality: "ok", opportunity: BRIEF };

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
  for (const m of [scrape, voice, analyse, generate, quota, recommend, pick, creds, setSpendReporter, recordSpendByDefault]) m.mockReset();
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
   * from one onboarding, none with a workspace_id. The reporter is armed for
   * the whole run, stamps every call with this workspace, and is cleared
   * however the run ends - including an abort partway through.
   */
  it("attributes every DataForSEO call in the run to the workspace, then disarms", async () => {
    analyse.mockImplementation(async () => {
      // What lib/seo/client does after each response, while discovery runs.
      const armed = setSpendReporter.mock.calls.at(-1)?.[0] as (e: unknown) => void;
      armed({ operation: "/dataforseo_labs/google/ranked_keywords/live", costUsd: 0.0132 });
      return { keywordsFound: 94 };
    });
    await collect();
    expect(recordSpendByDefault).toHaveBeenCalledWith({
      provider: "dataforseo",
      operation: "/dataforseo_labs/google/ranked_keywords/live",
      costUsd: 0.0132,
      workspaceId: "ws1",
    });
    expect(setSpendReporter.mock.calls[0][0]).toEqual(expect.any(Function));
    expect(setSpendReporter.mock.calls.at(-1)).toEqual([null]);
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
    recommend.mockResolvedValue([{ term: "seo agent", keywordId: "k1", action: "write", quality: "ok", reasons: ["r"], score: 1, difficulty: 1, volume: 10, opportunity: BRIEF }]);
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
    await runOnboarding(richClient(0), WS, () => undefined, { firstDraft: "dispatch", runId: "run-9" });
    expect(recordFunnel).toHaveBeenCalledOnce();
    // Recorded once drafting has settled: with nothing planned, the rule
    // still chose the first article from the recommender's approvals.
    expect(recordFunnel).toHaveBeenCalledWith({
      runId: "run-9", workspaceId: "ws1", accountId: "ag1", funnel: { ...FUNNEL, firstArticle: "rule" },
      planningDetail: "No keyword clear enough to plan yet.",
    });
  });

  it("still writes it when the planner throws after counting, with the failure as the reason", async () => {
    plan.mockImplementation(async (...a: unknown[]) => {
      (a[3] as { onFunnel?: (f: unknown) => void }).onFunnel?.({ ...FUNNEL, planned: 0 });
      throw new Error("Start your trial to keep going.");
    });
    await runOnboarding(richClient(0), WS, () => undefined, { firstDraft: "dispatch" });
    expect(recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ runId: null, funnel: { ...FUNNEL, planned: 0, firstArticle: "rule" }, planningDetail: "Start your trial to keep going." }));
  });

  it("writes a run with no keywords as one the planner never read", async () => {
    analyse.mockResolvedValue({ keywordsFound: 0, layers: [] });
    await runOnboarding(richClient(0), WS, () => undefined, { firstDraft: "dispatch" });
    expect(plan).not.toHaveBeenCalled();
    expect(recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ funnel: null, planningDetail: "Nothing to schedule until there are keywords." }));
  });
});

describe("runOnboarding: the first-article rule", () => {
  const brief = (value: number, extra: Record<string, unknown> = {}) => ({ ...BRIEF, value, ...extra });
  const recOf = (term: string, b: Record<string, unknown>) => ({ ...NEXT, term, keywordId: term, opportunity: b });
  beforeEach(() => recordFunnel.mockReset());

  it("writes the first planned topic of value 2 or more, not the plan's first day, and counts the rule", async () => {
    const general = brief(1, { tier: "t3" });
    const service = brief(3, { tier: "t1" });
    plan.mockImplementation(async (...a: unknown[]) => {
      (a[3] as { onFunnel?: (f: unknown) => void }).onFunnel?.({ found: 2, removed: {}, qualified: 2, planned: 2 });
      return [
        { term: "bike commuting tips", date: "2026-10-01", keywordId: "g", brief: general },
        { term: "tubeless conversion cost", date: "2026-10-02", keywordId: "s", brief: service },
      ];
    });
    recommend.mockResolvedValue([recOf("bike commuting tips", general), recOf("tubeless conversion cost", service)]);
    const { result } = await collectDispatch();
    expect(result.pendingDraft?.term).toBe("tubeless conversion cost");
    expect(result.pendingDraft?.selection.reviewNotes).toBeUndefined();
    expect(recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ funnel: expect.objectContaining({ firstArticle: "rule" }) }));
  });

  it("writes the best topic anyway when every one needs clinical claims, and asks the owner in the review notes", async () => {
    const a = brief(3, { tier: "t1" });
    const b = brief(2, { tier: "t1" });
    plan.mockResolvedValue([
      { term: "tooth extraction recovery time", date: "2026-10-01", keywordId: "a", brief: a },
      { term: "painkiller dosage after a dental implant", date: "2026-10-02", keywordId: "b", brief: b },
    ]);
    recommend.mockResolvedValue([recOf("tooth extraction recovery time", a), recOf("painkiller dosage after a dental implant", b)]);
    const { result } = await collectDispatch();
    expect(result.pendingDraft?.term).toBe("tooth extraction recovery time");
    expect(result.pendingDraft?.selection.reviewNotes?.[0]).toMatch(/^Needs your input before publishing: every planned topic about your services asks for clinical claims/);
  });

  it("writes a clinic's condition topic by the rule, not the fallback: the profession's words are not a claim", async () => {
    const a = brief(3, { tier: "t1", angle: "Dentist for sensitive teeth: what the visit involves" });
    plan.mockResolvedValue([{ term: "dentist for sensitive teeth", date: "2026-10-01", keywordId: "a", brief: a }]);
    recommend.mockResolvedValue([recOf("dentist for sensitive teeth", a)]);
    const { result } = await collectDispatch();
    expect(result.pendingDraft?.term).toBe("dentist for sensitive teeth");
    expect(result.pendingDraft?.selection.reviewNotes).toBeUndefined();
  });

  it("writes nothing first when no planned topic is about a service, says a person picks, and tells the operators", async () => {
    announceNoFirst.mockClear();
    const general = brief(1, { tier: "t3" });
    plan.mockImplementation(async (...a: unknown[]) => {
      (a[3] as { onFunnel?: (f: unknown) => void }).onFunnel?.({ found: 1, removed: {}, qualified: 1, planned: 1 });
      return [{ term: "bike commuting tips", date: "2026-10-01", keywordId: "g", brief: general }];
    });
    recommend.mockResolvedValue([recOf("bike commuting tips", general), recOf("wheel building cost", brief(3, { tier: "inventory" }))]);
    const events: OnboardingEvent[] = [];
    const result = await runOnboarding(richClient(0), WS, (e) => events.push(e), { firstDraft: "dispatch", runId: "run-7" });
    expect(result.pendingDraft).toBeNull();
    expect(events.filter((e) => e.phase === "drafting").at(-1)).toMatchObject({ status: "skipped", detail: expect.stringMatching(/No planned topic is about one of your services closely enough.*We will pick your first topic with you/) });
    expect(announceNoFirst).toHaveBeenCalledWith(expect.anything(), "run-7", expect.objectContaining({ workspaceId: "ws1" }), 1, expect.stringContaining("No planned topic"));
    expect(recordFunnel).toHaveBeenCalledWith(expect.objectContaining({ funnel: expect.objectContaining({ firstArticle: "none" }) }));
  });

  it("does not write a planned topic the second read no longer offers, and picks again among the planned", async () => {
    const first = brief(3, { tier: "t1" });
    const second = brief(2, { tier: "t1" });
    plan.mockResolvedValue([
      { term: "tubeless conversion cost", date: "2026-10-01", keywordId: "s", brief: first },
      { term: "brake rub fix", date: "2026-10-02", keywordId: "p", brief: second },
    ]);
    recommend.mockResolvedValue([{ ...recOf("tubeless conversion cost", first), action: "skip" }, recOf("brake rub fix", second)]);
    const { result } = await collectDispatch();
    expect(result.pendingDraft?.term).toBe("brake rub fix");
  });

  it("says the chosen topic was refused on the second read when no other planned topic is eligible", async () => {
    const first = brief(3, { tier: "t1" });
    const general = brief(1, { tier: "t3" });
    plan.mockResolvedValue([
      { term: "tubeless conversion cost", date: "2026-10-01", keywordId: "s", brief: first },
      { term: "bike commuting tips", date: "2026-10-02", keywordId: "g", brief: general },
    ]);
    recommend.mockResolvedValue([{ ...recOf("tubeless conversion cost", first), action: "skip" }, recOf("bike commuting tips", general)]);
    const { events, result } = await collectDispatch();
    expect(result.pendingDraft).toBeNull();
    const detail = (events.filter((e) => e.phase === "drafting").at(-1) as { detail?: string }).detail ?? "";
    expect(detail).toContain(`"tubeless conversion cost" was chosen as your first article`);
    expect(detail).not.toContain("No planned topic is about one of your services");
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

  it("reads qualified topics the value tiers kept in the queue as an answer: nothing planned, a person picks, no draft bought", async () => {
    const PLANNING = { stage: "planning" as const, cause: null, keywords: 30, qualified: 4, rejected: { buyer_mismatch: 26 }, pending: {}, summary: "4 of 30 searches qualified and the planner placed none of them." };
    emptyPool.mockResolvedValueOnce(PLANNING);
    plan.mockImplementation(async (...a: unknown[]) => {
      (a[3] as { onFunnel?: (f: unknown) => void }).onFunnel?.({ found: 30, removed: { buyer_mismatch: 26 }, qualified: 4, planned: 0, notPlanned: { inventory: 4 } });
      return [];
    });
    recommend.mockClear();
    const events = await collect();
    expect(planningEvent(events)).toMatchObject({ status: "skipped", emptyPool: { stage: "planning", cause: "value", qualified: 4 } });
    expect((planningEvent(events) as { detail?: string }).detail).toContain("none is both close enough to a service you list and within reach");
    expect(events.filter((e) => e.phase === "drafting").at(-1)).toMatchObject({ status: "skipped", detail: expect.stringContaining("We will pick it with you") });
    expect(recommend).not.toHaveBeenCalled();
  });

  it("leaves a planning pool the planner fell short on as it was", async () => {
    const PLANNING = { stage: "planning" as const, cause: null, keywords: 30, qualified: 4, rejected: {}, pending: {}, summary: "s" };
    emptyPool.mockResolvedValueOnce(PLANNING);
    plan.mockImplementation(async (...a: unknown[]) => {
      (a[3] as { onFunnel?: (f: unknown) => void }).onFunnel?.({ found: 4, removed: {}, qualified: 4, planned: 0, notPlanned: { no_room: 4 } });
      return [];
    });
    const events = await collect();
    expect(planningEvent(events)).toMatchObject({ emptyPool: PLANNING });
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
