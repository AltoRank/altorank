import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-runs-client";
import { EMPTY_PROFILE } from "../profile-shape";
import { firstLookIntentId } from "../first-look-selection";
const { owners, qualify, facts, spend, gate, gsc } = vi.hoisted(() => ({ owners: vi.fn(), qualify: vi.fn(), facts: vi.fn(), spend: vi.fn(), gate: vi.fn(), gsc: vi.fn() }));
vi.mock("@/lib/keyword-research/intent-leaders", () => ({ readIntentLeaders: (...a: unknown[]) => owners(...a), approvedWhenJudged: () => true }));
vi.mock("@/lib/keyword-research/opportunity", async (original) => ({ ...await original<typeof import("@/lib/keyword-research/opportunity")>(), qualifyOpportunities: (...a: unknown[]) => qualify(...a), spentSince: (...a: unknown[]) => spend(...a) }));
vi.mock("@/lib/seo/keywords", () => ({ fetchKeywordFacts: (...a: unknown[]) => facts(...a) }));
vi.mock("@/lib/gsc/read", () => ({ readGsc: (...a: unknown[]) => gsc(...a) }));
vi.mock("@/lib/billing/spend-gate", async (original) => ({ ...await original<typeof import("@/lib/billing/spend-gate")>(), canSpendOnSite: (...a: unknown[]) => gate(...a) }));
import { researchFirstArticle } from "../first-look-research";

const quote = "We design and build mobile applications for small businesses.";
const offering = "Mobile app development";
const context = { domain: "studio.example", languageCode: "en", locationCode: 2840,
  business: { ...EMPTY_PROFILE, name: "Studio", description: quote, offerings: [offering] } };
const proposal = { term: "mobile app cost", offering, serviceQuote: quote, decision: "cost", buyerDecision: "Set a realistic budget for commissioning a mobile app." };
const review = { intentId: firstLookIntentId(offering, "cost"), offered: true, buyerDecision: true, covered: false, distinct: true, priority: "primary", rationale: "Helps business owners budget for an app this studio builds." };
const verdict = { version: 2, context: "test", checkedAt: new Date().toISOString(), status: "qualified", funnel: "buyer", format: "article", reason: "An article answers this buying decision.", evidenceUrls: ["https://one.example/guide", "https://two.example/guide"], organicUrls: ["https://one.example/guide", "https://two.example/guide"] };
function setup() {
  const db = fakeDb({ keywords: [{ id: "k1", workspace_id: "ws1", term: proposal.term, status: "new", plan_excluded_at: null },
    { id: "foreign", workspace_id: "ws2", term: proposal.term, status: "new", plan_excluded_at: null }] });
  const ask = vi.fn().mockResolvedValueOnce(JSON.stringify([proposal])).mockResolvedValueOnce(JSON.stringify([review]));
  const run = () => researchFirstArticle(db.client, "ws1", context, quote, { since: new Date().toISOString() }, ask);
  return { db, ask, run };
}
beforeEach(() => {
  vi.resetAllMocks(); owners.mockResolvedValue([]); spend.mockResolvedValue(0); gate.mockResolvedValue({ allowed: true });
  facts.mockResolvedValue(new Map()); gsc.mockResolvedValue({ query: [] }); qualify.mockResolvedValue(new Map([["k1", verdict]]));
});
describe("bounded first-article research", () => {
  it("works without GSC or reported volume and persists evidence only on the requested workspace", async () => {
    const { run, db, ask } = setup();
    gsc.mockRejectedValue(new Error("not connected"));
    const selected = await run();
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ keywordId: "k1", volume: null, demand: "unmeasured", opportunity: { firstArticle: { serviceQuote: quote, offering } } });
    expect(db.tables.keywords.find((r) => r.id === "foreign")?.opportunity).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(facts).toHaveBeenCalledWith([proposal.term], context);
  });
  it("stops without provider calls when the service quote is unsupported", async () => {
    const { run, ask } = setup();
    ask.mockReset().mockResolvedValue(JSON.stringify([{ ...proposal, serviceQuote: "We perform complex surgeries in our private clinic." }]));
    expect(await run()).toEqual([]); expect(facts).not.toHaveBeenCalled(); expect(qualify).not.toHaveBeenCalled();
  });
  it("honours semantic coverage and buyer-decision refusals before paying for SERPs", async () => {
    const { run, ask } = setup();
    ask.mockReset().mockResolvedValueOnce(JSON.stringify([proposal])).mockResolvedValueOnce(JSON.stringify([{ ...review, covered: true }]));
    expect(await run()).toEqual([]); expect(facts).not.toHaveBeenCalled();
  });
  it("does not call a missing review or pending SERP verdict a clean refusal", async () => {
    const first = setup();
    first.ask.mockReset().mockResolvedValueOnce(JSON.stringify([proposal])).mockResolvedValueOnce("[]");
    await expect(first.run()).rejects.toThrow("incomplete");
    qualify.mockResolvedValue(new Map([["k1", { ...verdict, status: "pending" }]]));
    await expect(setup().run()).rejects.toThrow("did not finish");
  });
  it("fails closed on a coverage read error", async () => {
    owners.mockRejectedValue(new Error("coverage unavailable"));
    await expect(setup().run()).rejects.toThrow("coverage unavailable"); expect(facts).not.toHaveBeenCalled();
  });
  it("does not resurrect a topic the person excluded", async () => {
    const { run, db } = setup(); db.tables.keywords[0].plan_excluded_at = new Date().toISOString();
    expect(await run()).toEqual([]);
    expect(qualify.mock.calls[0][2]).toEqual([]);
  });
  it("stops before proposing when the draft reserve is all that remains", async () => {
    spend.mockResolvedValue(0.71);
    const { run, ask } = setup(); await expect(run()).rejects.toThrow("budget"); expect(ask).not.toHaveBeenCalled();
  });
});
