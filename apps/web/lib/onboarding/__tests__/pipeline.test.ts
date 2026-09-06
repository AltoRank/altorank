import { describe, it, expect, vi, beforeEach } from "vitest";

const scrape = vi.fn();
const voice = vi.fn();
const analyse = vi.fn();
const generate = vi.fn();
const quota = vi.fn();
const recommend = vi.fn();
const pick = vi.fn();
const creds = vi.fn();

vi.mock("../site-text", () => ({ readSiteText: async (...a: unknown[]) => { const text = (await scrape(...a)) as string; return { text, source: text ? "static" : "none", chars: text.length }; } }));
vi.mock("@/app/actions/voice", () => ({ createVoiceProfile: (...a: unknown[]) => voice(...a) }));
vi.mock("@/lib/audit/domain-analysis", () => ({ analyseDomain: (...a: unknown[]) => analyse(...a) }));
vi.mock("@/lib/content/generate", () => ({ generateArticle: (...a: unknown[]) => generate(...a) }));
vi.mock("@/lib/billing/quota", () => ({ getQuota: (...a: unknown[]) => quota(...a) }));
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
const plan = vi.fn(async () => [] as unknown[]);
vi.mock("../plan", () => ({ schedulePlan: () => plan(), fulfilPlannedEntry: vi.fn(async () => undefined) }));

import { runOnboarding } from "../pipeline";
import type { OnboardingEvent } from "../events";

const WS = { id: "ws1", domain: "example.com", agency_id: "ag1", language: "en" };
const NEXT = { term: "seo agent", reasons: ["27,100 searches/mo"], score: 35.5, difficulty: 19, volume: 27100 };

/** Enough client for the "already has a draft?" count. */
const client = (existing: number) =>
  ({ from: () => ({ select: () => ({ eq: async () => ({ count: existing }) }) }) }) as never;

async function collect(existing = 0): Promise<OnboardingEvent[]> {
  const events: OnboardingEvent[] = [];
  await runOnboarding(client(existing), WS, (e) => events.push(e));
  return events;
}

const phases = (events: OnboardingEvent[]) =>
  events.map((e) => ("status" in e ? `${e.phase}:${e.status}` : e.phase));

beforeEach(() => {
  for (const m of [scrape, voice, analyse, generate, quota, recommend, pick, creds, setSpendReporter, recordSpendByDefault]) m.mockReset();
  scrape.mockResolvedValue("word ".repeat(80));
  voice.mockResolvedValue(undefined);
  creds.mockReturnValue(true);
  analyse.mockResolvedValue({ keywordsFound: 94 });
  quota.mockResolvedValue({ limit: 1, used: 0, remaining: 1, reason: "no-plan" });
  recommend.mockResolvedValue([NEXT]);
  pick.mockReturnValue(NEXT);
  generate.mockResolvedValue({
    articleId: "a1", title: "What an SEO agent does", wordCount: 1200,
    factCheck: { verdict: "clean" },
  });
});

describe("runOnboarding", () => {
  it("emits every boundary of a full run, in order, ending in ready", async () => {
    const events = await collect();
    expect(phases(events)).toEqual([
      "scanning:active", "scanning:done",
      "keywords:active", "keywords:done",
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
   * A client that aborted must not get a crawl and a paid article written for
   * nobody. The phase in flight finishes; the next one never starts.
   */
  it("stops at the next phase boundary once the request is aborted", async () => {
    const ac = new AbortController();
    const events: OnboardingEvent[] = [];
    scrape.mockImplementation(async () => { ac.abort(); return "word ".repeat(80); });
    await runOnboarding(client(0), WS, (e) => events.push(e), ac.signal);
    expect(phases(events)).toEqual(["scanning:active", "scanning:done"]);
    expect(analyse).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("runs to completion when the signal is never aborted", async () => {
    const ac = new AbortController();
    const events: OnboardingEvent[] = [];
    await runOnboarding(client(0), WS, (e) => events.push(e), ac.signal);
    expect(events.at(-1)).toEqual({ phase: "ready" });
  });

  it("skips the draft, with the reason, when the free draft is used", async () => {
    quota.mockResolvedValue({ limit: 1, used: 1, remaining: 0, reason: "no-plan" });
    const events = await collect();
    expect(generate).not.toHaveBeenCalled();
    expect(events.find((e) => e.phase === "drafting" && "status" in e && e.status !== "active"))
      .toMatchObject({ status: "skipped", detail: expect.stringContaining("free draft") });
    expect(events.at(-1)).toEqual({ phase: "ready" });
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

  it("disarms the spend reporter when the run is aborted early", async () => {
    const ac = new AbortController();
    scrape.mockImplementation(async () => { ac.abort(); return "word ".repeat(80); });
    await runOnboarding(client(0), WS, () => {}, ac.signal);
    expect(setSpendReporter.mock.calls.at(-1)).toEqual([null]);
  });

  it("skips everything that needs a domain when there is none", async () => {
    const events: OnboardingEvent[] = [];
    await runOnboarding(client(0), { ...WS, domain: null }, (e) => events.push(e));
    expect(scrape).not.toHaveBeenCalled();
    expect(analyse).not.toHaveBeenCalled();
    expect(phases(events).slice(0, 4)).toEqual(["scanning:active", "scanning:skipped", "keywords:active", "keywords:skipped"]);
  });
});
