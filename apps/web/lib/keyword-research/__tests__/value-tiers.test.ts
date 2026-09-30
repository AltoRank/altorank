import { describe, expect, it } from "vitest";
import type { Opportunity } from "../opportunity";
import {
  capValue, chooseFirstArticle, firstArticleEligible, planOrder, readValue, selectPlan, serviceList, tierCaps, tierOf, valueOf,
  UNMEASURED_WEIGHT, WINNABLE_AT, type BusinessValue, type Rankable,
} from "../value-tiers";
import { factRiskOf, namesYear } from "../fact-risk";

/**
 * The value-first rules on invented topics for invented businesses: a bike
 * workshop, a dental practice and a solar-panel fitter (acme-*.example).
 */

describe("the grade", () => {
  it("reads the services from the profile, trimmed, one of each", () => {
    expect(serviceList({ offerings: [" Bike servicing ", "bike servicing", "", "none", "Wheel  building"] })).toEqual(["Bike servicing", "Wheel building"]);
    expect(serviceList(null)).toEqual([]);
    expect(serviceList({ offerings: Array.from({ length: 20 }, (_, i) => `service ${i}`) })).toHaveLength(12);
  });
  it("reads 0-3 and nothing else", () => {
    expect([0, 1, 2, 3, "2"].map(readValue)).toEqual([0, 1, 2, 3, 2]);
    expect([4, -1, 1.5, null, undefined, "", "two"].map(readValue)).toEqual([null, null, null, null, null, null, null]);
  });
  it("caps a grade above 1 at 1 when no listed service is named", () => {
    const services = ["Bike servicing", "Wheel building"];
    expect(capValue(3, "bike servicing", services)).toEqual({ value: 3, service: "Bike servicing", capped: false });
    expect(capValue(3, "none", services)).toEqual({ value: 1, service: null, capped: true });
    expect(capValue(2, "frame painting", services)).toEqual({ value: 1, service: null, capped: true });
    expect(capValue(2, undefined, [])).toEqual({ value: 1, service: null, capped: true });
    expect(capValue(1, "none", services)).toEqual({ value: 1, service: null, capped: false });
    expect(capValue(0, "Bike servicing", services)).toEqual({ value: 0, service: "Bike servicing", capped: false });
  });
  it("reads an ungraded verdict (saved before the grade existed) as value 1", () => {
    expect(valueOf({})).toBe(1);
    expect(valueOf(null)).toBe(1);
    expect(valueOf({ value: 3 })).toBe(3);
  });
});

describe("tiers and order", () => {
  it("places value and winnability in the tiers", () => {
    const easy = WINNABLE_AT + 0.1, hard = WINNABLE_AT - 0.1;
    expect([tierOf(3, easy), tierOf(2, easy), tierOf(3, hard), tierOf(2, hard), tierOf(1, easy), tierOf(1, hard), tierOf(0, easy)])
      .toEqual(["t1", "t1", "t2", "inventory", "t3", "inventory", "inventory"]);
    // An unknown difficulty (0.6) is winnable.
    expect(tierOf(2, 0.6)).toBe("t1");
  });
  const r = (term: string, value: BusinessValue, winnability: number, volume: number | null, extra: Partial<Rankable> = {}): Rankable => ({ term, value, winnability, volume, ...extra });
  it("orders by tier, then winnability, then volume: volume only breaks ties", () => {
    const list = [
      r("general interest, huge", 1, 0.9, 50_000),
      r("service, hard", 3, 0.2, 5_000),
      r("problem, easy", 2, 0.9, 40),
      r("service, easy", 3, 0.9, 30),
      r("service, easy, more searched", 3, 0.88, 300),
      r("problem, a little harder", 2, 0.7, 9_000),
    ];
    expect([...list].sort(planOrder).map((x) => x.term)).toEqual([
      "service, easy, more searched", "problem, easy", "service, easy", "problem, a little harder", "service, hard", "general interest, huge",
    ]);
  });
  it("counts an unmeasured term's winnability at 0.35 within its tier: below a measured one, above a hard one", () => {
    const measured = r("measured", 2, 0.6, 20);
    const unmeasured = r("unmeasured", 2, 1, null, { unmeasured: true });
    const hardMeasured = r("hard measured", 2, WINNABLE_AT, 20);
    expect(UNMEASURED_WEIGHT).toBe(0.35);
    expect([unmeasured, hardMeasured, measured].sort(planOrder).map((x) => x.term)).toEqual(["measured", "hard measured", "unmeasured"]);
    // Tier first: an unmeasured T1 is still ahead of every T3.
    expect([r("t3", 1, 1, 90_000), unmeasured].sort(planOrder)[0].term).toBe("unmeasured");
  });
});

describe("the plan", () => {
  const r = (term: string, value: BusinessValue, winnability = 0.9): Rankable => ({ term, value, winnability, volume: 100 });
  const plan = (items: Rankable[], relax = true, slots = 5) => selectPlan(items, (x) => x, { slots, relax });
  const names = (s: ReturnType<typeof plan>) => s.picks.map((p) => `${p.item.term}:${p.tier}${p.relaxed ? "*" : ""}`);

  it("holds 3 of 5 for revenue topics and at most one each of T2 and T3", () => {
    expect(tierCaps(5)).toEqual({ revenue: 3, t2: 1, t3: 1 });
    expect(tierCaps(10)).toEqual({ revenue: 6, t2: 2, t3: 2 });
    expect(tierCaps(2)).toEqual({ revenue: 2, t2: 1, t3: 1 });
    const items = [r("a", 3), r("b", 2), r("c", 3, 0.2), r("d", 3, 0.1), r("e", 1), r("f", 1), r("g", 1, 0.1)];
    const s = plan(items, false);
    expect(names(s)).toEqual(["a:t1", "b:t1", "c:t2", "e:t3"]);
    expect(s.left.map((l) => `${l.item.term}:${l.why}`)).toEqual(["d:tier_full", "f:tier_full", "g:inventory"]);
    expect(s.relaxations).toEqual([]);
    // A first look fills T1's third slot from the next T2, labelled.
    const relaxed = plan(items);
    expect(names(relaxed)).toEqual(["a:t1", "b:t1", "c:t2", "d:t2*", "e:t3"]);
    expect(relaxed.relaxations).toEqual(["lower_confidence"]);
    expect(relaxed.left.map((l) => `${l.item.term}:${l.why}`)).toEqual(["f:tier_full", "g:inventory"]);
  });
  it("fills T1 first when it has plenty, and says the rest had no room", () => {
    const s = plan([r("a", 3), r("b", 3), r("c", 2), r("d", 2), r("e", 2), r("f", 2), r("x", 1)]);
    expect(names(s)).toEqual(["a:t1", "b:t1", "c:t1", "d:t1", "e:t1"]);
    expect(s.left.map((l) => l.why)).toEqual(["no_room", "no_room"]);
    expect(s.relaxations).toEqual([]);
  });
  it("relaxes in order on a first look: the revenue rule drops, then T1's share fills from T2, then T3, labelled", () => {
    const s = plan([r("only", 2), r("bet1", 3, 0.1), r("bet2", 3, 0.2), r("tof1", 1), r("tof2", 1), r("tof3", 1)]);
    // T1 short by 2: one more T2, then one more T3, both relaxed.
    expect(names(s)).toEqual(["only:t1", "bet2:t2", "bet1:t2*", "tof1:t3", "tof2:t3*"]);
    expect(s.relaxations).toEqual(["revenue_slots", "lower_confidence"]);
    const noRevenue = plan([r("tof1", 1), r("tof2", 1), r("tof3", 1), r("tof4", 1)]);
    expect(names(noRevenue)).toEqual(["tof1:t3", "tof2:t3*", "tof3:t3*", "tof4:t3*"]);
    expect(noRevenue.relaxations).toEqual(["revenue_slots", "lower_confidence"]);
  });
  it("does not relax on a nightly top-up", () => {
    const s = plan([r("only", 2), r("bet1", 3, 0.1), r("bet2", 3, 0.2), r("tof1", 1), r("tof2", 1)], false);
    expect(names(s)).toEqual(["only:t1", "bet2:t2", "tof1:t3"]);
    expect(s.left.map((l) => `${l.item.term}:${l.why}`)).toEqual(["bet1:tier_full", "tof2:tier_full"]);
  });
  it("never plans inventory, however short the plan", () => {
    const s = plan([r("hard problem", 2, 0.1), r("hard general", 1, 0.1)]);
    expect(s.picks).toEqual([]);
    expect(s.left.map((l) => l.why)).toEqual(["inventory", "inventory"]);
  });
});

describe("the first article", () => {
  const brief = (value: number, extra: Partial<Opportunity> = {}): Opportunity => ({
    version: 2, context: "c", checkedAt: "2026-09-30T00:00:00.000Z", status: "qualified", reason: "r", format: "article", value: value as BusinessValue, angle: "", buyingJob: "", ...extra,
  });
  const item = (term: string, b: Opportunity) => ({ term, brief: b });
  const choose = (items: Array<ReturnType<typeof item>>, language = "en", profile?: unknown) => chooseFirstArticle(items, (x) => x, { language, profile });

  it("takes the first planned topic of value 2 or more on an editorial page with no fact risk, not the first planned", () => {
    const c = choose([item("stretching for cyclists", brief(1)), item("tubeless or inner tubes for gravel", brief(3)), item("brake rub fix", brief(2))]);
    expect(c).toMatchObject({ rule: "rule", pick: { term: "tubeless or inner tubes for gravel" }, notes: [] });
  });
  it("skips a fact-risky topic when a clean one exists", () => {
    const solar = [
      item("solar panel grants for homeowners", brief(3)),
      item("solar panel cleaning how often", brief(2)),
    ];
    const c = choose(solar);
    expect(c.pick?.term).toBe("solar panel cleaning how often");
  });
  it("falls back to the best topic when every one needs clinical claims, and asks the owner", () => {
    const dental = [
      item("dental crown or veneer", brief(3)),
      item("dental implant recovery time", brief(3)),
    ];
    const c = choose(dental, "en", { description: "Acme Dental is a dental practice." });
    expect(c.rule).toBe("fact_risk_fallback");
    expect(c.pick?.term).toBe("dental crown or veneer");
    expect(c.risk).toMatchObject({ kind: "health", evidence: expect.stringContaining("dental") });
    expect(c.notes[0]).toMatch(/^Needs your input before publishing/);
    expect(c.notes[0]).toContain("clinical");
  });
  it("never writes a value-1, a needs_page or a not-yet-approved topic first", () => {
    expect(choose([item("general", brief(1)), item("page", brief(3, { status: "rejected", cause: "needs_page" })), item("mixed but ungraded", brief(2, { value: undefined }))]))
      .toMatchObject({ pick: null, rule: "none" });
    expect(firstArticleEligible(brief(2, { format: "mixed" }))).toBe(true);
    expect(firstArticleEligible(brief(2, { format: "product" }))).toBe(false);
  });
  it("flags a year for a yearly refresh instead of refusing it", () => {
    const c = choose([item("gravel bike maintenance checklist 2027", brief(2))]);
    expect(c).toMatchObject({ rule: "rule", refreshYearly: true });
    expect(c.notes).toEqual(["The topic names a year: refresh this article every year."]);
    expect(namesYear("20270 widgets")).toBe(false);
  });
});

describe("fact risk", () => {
  it("reads health, rules and incentives from the topic, in the market's language and English", () => {
    expect(factRiskOf({ term: "tubeless setup guide", language: "en" })).toBeNull();
    expect(factRiskOf({ term: "wisdom tooth pain relief", language: "en" })?.kind).toBe("health");
    expect(factRiskOf({ term: "incentivi pannelli solari", language: "it" })?.kind).toBe("incentive");
    expect(factRiskOf({ term: "normativa installazione pannelli", language: "it" })?.kind).toBe("regulation");
    expect(factRiskOf({ term: "güneş paneli teşvik", language: "tr" })?.kind).toBe("incentive");
    expect(factRiskOf({ term: "solar panel permits", language: "en" })?.kind).toBe("regulation");
  });
  it("does not read the business profile alone as the topic's risk", () => {
    expect(factRiskOf({ term: "how to book online", language: "en", profile: { description: "A physiotherapy clinic treating sports injuries and back pain." } })).toBeNull();
  });
});
