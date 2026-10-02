import { describe, expect, it } from "vitest";
import { applyFirstLookReview, firstLookIntentId, parseFirstLookCandidates, selectFirstLookCandidates, type QualifiedFirstLookCandidate } from "../first-look-selection";
import { EMPTY_PROFILE } from "../profile-shape";
import type { Opportunity } from "@/lib/keyword-research/opportunity";

const quote = "Our team designs and builds mobile applications for growing businesses.";
const profile = { ...EMPTY_PROFILE, offerings: ["Mobile app development"] };
const proposal = { term: "mobile app development cost", offering: profile.offerings[0], serviceQuote: quote,
  decision: "cost", buyerDecision: "Decide whether the business can fund a professionally built mobile app." };
const parsed = () => parseFirstLookCandidates([proposal], profile, quote);
const opportunity: Opportunity = { version: 2, context: "test", checkedAt: new Date().toISOString(), status: "qualified", funnel: "buyer", reason: "An editorial buyer decision.",
  format: "article", evidenceUrls: ["https://one.example/guide", "https://two.example/guide"], organicUrls: ["https://one.example/guide", "https://two.example/guide"] };
const candidate = (patch: Partial<QualifiedFirstLookCandidate> = {}): QualifiedFirstLookCandidate => ({
  ...parsed()[0], id: "k1", priority: "primary", rationale: "Helps an app buyer decide what budget to set.", volume: null, difficulty: null, impressions: null, opportunity, ...patch,
});

describe("first-article eligibility", () => {
  it("accepts a verbatim service passage and preserves its evidence", () => {
    expect(parsed()).toEqual([expect.objectContaining({ serviceQuote: quote, intentId: firstLookIntentId(profile.offerings[0], "cost") })]);
  });
  it("refuses an invented passage or offering", () => {
    expect(parseFirstLookCandidates([{ ...proposal, serviceQuote: "We also carry out specialised spinal surgery." }], profile, quote)).toEqual([]);
    expect(parseFirstLookCandidates([{ ...proposal, offering: "Surgery" }], profile, quote)).toEqual([]);
  });
  it("groups variant wording under a stable service/decision identity", () => {
    const result = parseFirstLookCandidates([proposal, { ...proposal, term: "how much does an app cost" }], profile, quote);
    expect(result).toHaveLength(1);
    expect(firstLookIntentId(" MOBILE app DEVELOPMENT ", "cost")).toBe(result[0].intentId);
  });
  it("requires a separate explicit offered-service, buying-decision and coverage review", () => {
    const yes = { intentId: parsed()[0].intentId, offered: true, buyerDecision: true, covered: false, distinct: true, priority: "primary", rationale: "This helps a buyer fund an app the company builds." };
    expect(applyFirstLookReview([yes], parsed())).toHaveLength(1);
    for (const patch of [{ offered: false }, { buyerDecision: false }, { covered: true }, { distinct: false }, { covered: undefined }]) {
      expect(applyFirstLookReview([{ ...yes, ...patch }], parsed())).toEqual([]);
    }
    expect(applyFirstLookReview([yes, yes], parsed())).toEqual([]);
    expect(applyFirstLookReview([], parsed())).toEqual([]);
  });
  it("does not promote a one-article floor pick or a service-page result", () => {
    for (const patch of [{ confidence: "lower" as const }, { floor: true }, { format: "service" }, { status: "pending" as const }, { existingUrl: "https://own.example/guide" }, { evidenceUrls: ["https://one.example/guide"] }]) {
      expect(selectFirstLookCandidates([candidate({ opportunity: { ...opportunity, ...patch } })], "en")).toEqual([]);
    }
  });
  it("requires distinct observed evidence URLs", () => {
    expect(selectFirstLookCandidates([candidate({ opportunity: { ...opportunity, evidenceUrls: ["https://fake.example", "https://fake.example"] } })], "en")).toEqual([]);
  });
  it("refuses an audience-level approval even when the separate proposal review approved it", () => {
    expect(selectFirstLookCandidates([candidate({ opportunity: { ...opportunity, funnel: "audience" } })], "en")).toEqual([]);
  });
  it("lets an unmeasured primary service beat a measured secondary one", () => {
    const secondary = candidate({ id: "k2", term: "web agency pricing", intentId: "other", priority: "secondary", volume: 10000 });
    expect(selectFirstLookCandidates([secondary, candidate()], "en")[0].id).toBe("k1");
  });
  it("does not equate unknown demand with a measured zero", () => {
    const zero = candidate({ id: "zero", intentId: "zero", term: "unrelated purchase decision", volume: 0, opportunity: { ...opportunity, organicUrls: ["https://zero.example/a", "https://zero.example/b"], evidenceUrls: ["https://zero.example/a", "https://zero.example/b"] } });
    expect(selectFirstLookCandidates([zero, candidate()], "en")[0].volume).toBeNull();
  });
  it("checks shared search results even across different service/decision IDs", () => {
    const urls = [1, 2, 3, 4].map((n) => `https://source${n}.example/guide`);
    const a = candidate({ opportunity: { ...opportunity, organicUrls: urls, evidenceUrls: urls } });
    const b = { ...a, id: "b", term: "how much does bespoke software cost", intentId: "another-service" };
    expect(selectFirstLookCandidates([a, b], "en")).toHaveLength(1);
  });
  it("keeps a short plan instead of filling to three", () => {
    expect(selectFirstLookCandidates([candidate()], "en")).toHaveLength(1);
    expect(selectFirstLookCandidates([], "en")).toEqual([]);
  });
});
