import { describe, expect, it } from "vitest";
import type { Opportunity } from "../opportunity";
import {
  capValue, chooseFirstArticle, firstArticleEligible, plannableApproval, planOrder, readMatch, readValue, selectPlan, serviceList, tierCaps, tierOf, valueOf,
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
    expect(capValue(3, "bike servicing", services, "named")).toEqual({ value: 3, service: "Bike servicing", capped: false });
    expect(capValue(3, "none", services, "adjacent")).toEqual({ value: 1, service: null, capped: true, cap: "no_service" });
    expect(capValue(2, "frame painting", services, "named")).toEqual({ value: 1, service: null, capped: true, cap: "no_service" });
    expect(capValue(1, "none", services, "adjacent")).toEqual({ value: 1, service: null, capped: false });
    expect(capValue(0, "Bike servicing", services, "named")).toEqual({ value: 0, service: "Bike servicing", capped: false });
  });
  it("holds the grade to how the search reaches the service: named for 3, not adjacent for 2", () => {
    const services = ["Bike servicing", "Wheel building"];
    // A listed service is always nameable, so "which" is not enough without "how".
    expect(capValue(3, "Bike servicing", services, "implied")).toEqual({ value: 2, service: "Bike servicing", capped: true, cap: "implied" });
    expect(capValue(3, "Bike servicing", services, null)).toEqual({ value: 2, service: "Bike servicing", capped: true, cap: "implied" });
    expect(capValue(2, "Bike servicing", services, "implied")).toEqual({ value: 2, service: "Bike servicing", capped: false });
    expect(capValue(2, "Wheel building", services, "adjacent")).toEqual({ value: 1, service: null, capped: true, cap: "adjacent" });
    expect(capValue(3, "Wheel building", services, "adjacent")).toEqual({ value: 1, service: null, capped: true, cap: "adjacent" });
    expect(readMatch("named")).toBe("named");
    expect(readMatch("maybe")).toBeNull();
  });
  it("leaves the grade uncapped, and flags it, when the profile lists no services", () => {
    expect(capValue(2, undefined, [], null)).toEqual({ value: 2, service: null, capped: false, unlisted: true });
    expect(capValue(3, "none", [], "adjacent")).toEqual({ value: 3, service: null, capped: false, unlisted: true });
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
  it("orders by tier, then value, then winnability, then volume: volume only breaks ties", () => {
    const list = [
      r("general interest, huge", 1, 0.9, 50_000),
      r("service, hard", 3, 0.2, 5_000),
      r("problem, easy", 2, 0.9, 40),
      r("service, easy", 3, 0.9, 30),
      r("service, easy, more searched", 3, 0.88, 300),
      r("problem, a little harder", 2, 0.7, 9_000),
    ];
    expect([...list].sort(planOrder).map((x) => x.term)).toEqual([
      "service, easy, more searched", "service, easy", "problem, easy", "problem, a little harder", "service, hard", "general interest, huge",
    ]);
  });
  it("ranks value 3 above value 2 inside T1 when winnability is flat (unknown difficulty), whatever the volume", () => {
    const flat = [r("problem, big", 2, 0.6, 1300), r("problem, bigger", 2, 0.6, 5000), r("service, small", 3, 0.6, 40), r("service, mid", 3, 0.6, 480)];
    expect([...flat].sort(planOrder).map((x) => x.term)).toEqual(["service, mid", "service, small", "problem, bigger", "problem, big"]);
    const s = selectPlan([...flat, r("problem, more", 2, 0.6, 900), r("problem, most", 2, 0.6, 800)], (x) => x, { slots: 5, relax: true });
    expect(s.picks.map((p) => p.item.term)).toEqual(["service, mid", "service, small", "problem, bigger", "problem, big", "problem, more"]);
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
    expect(tierCaps(5)).toEqual({ revenue: 3, t2: 1, t3: 1, t3Total: 1 });
    expect(tierCaps(10)).toEqual({ revenue: 6, t2: 2, t3: 2, t3Total: 2 });
    // Shorter than five: no top-of-funnel slot of its own, one at most relaxed.
    expect(tierCaps(2)).toEqual({ revenue: 2, t2: 1, t3: 0, t3Total: 1 });
    expect(tierCaps(1)).toEqual({ revenue: 1, t2: 1, t3: 0, t3Total: 1 });
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
  it("relaxes in order on a first look: the revenue rule drops, then T1's share fills from T2, then value-2 topics out of reach, labelled", () => {
    const s = plan([r("only", 2), r("bet1", 3, 0.1), r("bet2", 3, 0.2), r("hard problem", 2, 0.3), r("tof1", 1), r("tof2", 1), r("tof3", 1)]);
    // T1 short by 2: one more T2, then the value-2 topic out of reach; never a second top-of-funnel topic.
    expect(names(s)).toEqual(["only:t1", "bet2:t2", "bet1:t2*", "hard problem:t2*", "tof1:t3"]);
    expect(s.relaxations).toEqual(["revenue_slots", "lower_confidence"]);
  });
  it("keeps top of funnel at one in five, relaxed picks included", () => {
    // Every topic general interest (a first look with nothing about a service): one slot, not four.
    const noRevenue = plan([r("tof1", 1), r("tof2", 1), r("tof3", 1), r("tof4", 1)]);
    expect(names(noRevenue)).toEqual(["tof1:t3"]);
    expect(noRevenue.relaxations).toEqual(["revenue_slots"]);
    expect(noRevenue.left.map((l) => l.why)).toEqual(["tier_full", "tier_full", "tier_full"]);
    const mix = plan([r("a", 2), r("bet", 3, 0.2), r("tof1", 1), r("tof2", 1)]);
    expect(names(mix)).toEqual(["a:t1", "bet:t2", "tof1:t3"]);
  });
  it("never makes a short plan all top of funnel unless relaxed", () => {
    // One slot (a calendar held at its first article), one general-interest topic.
    expect(names(plan([r("tof", 1)], false, 1))).toEqual([]);
    expect(names(plan([r("tof", 1)], true, 1))).toEqual(["tof:t3*"]);
    expect(names(plan([r("svc", 3), r("tof", 1)], true, 1))).toEqual(["svc:t1"]);
  });
  it("does not relax on a nightly top-up", () => {
    const s = plan([r("only", 2), r("bet1", 3, 0.1), r("bet2", 3, 0.2), r("tof1", 1), r("tof2", 1)], false);
    expect(names(s)).toEqual(["only:t1", "bet2:t2", "tof1:t3"]);
    expect(s.left.map((l) => `${l.item.term}:${l.why}`)).toEqual(["bet1:tier_full", "tof2:tier_full"]);
  });
  it("plans a value-2 topic out of reach only to fill a first look, and general interest out of reach never", () => {
    const s = plan([r("hard problem", 2, 0.1), r("hard general", 1, 0.1)]);
    expect(names(s)).toEqual(["hard problem:t2*"]);
    expect(s.left.map((l) => l.why)).toEqual(["inventory"]);
    expect(plan([r("hard problem", 2, 0.1), r("hard general", 1, 0.1)], false).picks).toEqual([]);
  });
  it("counts as plannable only an approval in a tier, never inventory or a retired floor approval", () => {
    const o = (value: BusinessValue, extra: Partial<Opportunity> = {}): Opportunity => ({ version: 2, context: "c", checkedAt: "x", status: "qualified", reason: "r", value, ...extra });
    expect(plannableApproval(o(2), 0.9)).toBe(true);
    expect(plannableApproval(o(1), 0.9)).toBe(true);
    expect(plannableApproval(o(2), 0.1)).toBe(false);
    expect(plannableApproval(o(3), 0.1)).toBe(true);
    expect(plannableApproval(o(2, { status: "rejected" }), 0.9)).toBe(false);
    expect(plannableApproval(o(3, { confidence: "lower", reason: "Lower confidence: fewer articles hold this search than the bar asks for" }), 0.9)).toBe(false);
  });
});

describe("the first article", () => {
  const brief = (value: number, extra: Partial<Opportunity> = {}): Opportunity => ({
    version: 2, context: "c", checkedAt: "2026-09-30T00:00:00.000Z", status: "qualified", reason: "r", format: "article", value: value as BusinessValue, angle: "", buyingJob: "", ...extra,
  });
  const item = (term: string, b: Opportunity) => ({ term, brief: b });
  const choose = (items: Array<ReturnType<typeof item>>, language = "en") => chooseFirstArticle(items, (x) => x, { language });

  it("takes the first planned topic of value 2 or more on an editorial page with no fact risk, not the first planned", () => {
    const c = choose([item("stretching for cyclists", brief(1)), item("tubeless or inner tubes for gravel", brief(3)), item("brake rub fix", brief(2))]);
    expect(c).toMatchObject({ rule: "rule", pick: { term: "tubeless or inner tubes for gravel" }, notes: [] });
  });
  it("skips a fact-risky topic when a clean one exists", () => {
    const heating = [
      item("boiler replacement grants for homeowners", brief(3)),
      item("boiler pressure keeps dropping", brief(2)),
    ];
    const c = choose(heating);
    expect(c.pick?.term).toBe("boiler pressure keeps dropping");
  });
  it("writes a clinic's condition explainer by the rule: the profession's own words are not a claim", () => {
    const dental = [
      item("dentist for sensitive teeth", brief(3, { angle: "Sensitive teeth: what a dentist checks and treats" })),
      item("dental crown or veneer", brief(3)),
    ];
    const c = choose(dental);
    expect(c).toMatchObject({ rule: "rule", pick: { term: "dentist for sensitive teeth" }, risk: null, notes: [] });
  });
  it("falls back to the best topic when every one needs clinical claims, and asks the owner", () => {
    const dental = [
      item("tooth extraction recovery time", brief(3)),
      item("dental implant healing time", brief(3)),
    ];
    const c = choose(dental);
    expect(c.rule).toBe("fact_risk_fallback");
    expect(c.pick?.term).toBe("tooth extraction recovery time");
    expect(c.risk).toMatchObject({ kind: "health", evidence: expect.stringContaining("recovery time") });
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
  it("reads claims, rules and incentives from the topic, in the market's language and English", () => {
    expect(factRiskOf({ term: "tubeless setup guide", language: "en" })).toBeNull();
    expect(factRiskOf({ term: "painkiller dosage after a tooth extraction", language: "en" })?.kind).toBe("health");
    expect(factRiskOf({ term: "contributi caldaia a condensazione", language: "it" })).toBeNull();
    expect(factRiskOf({ term: "detrazione caldaia a condensazione", language: "it" })?.kind).toBe("incentive");
    expect(factRiskOf({ term: "permesso di costruire veranda", language: "it" })?.kind).toBe("regulation");
    expect(factRiskOf({ term: "kombi değişimi teşvik", language: "tr" })?.kind).toBe("incentive");
    expect(factRiskOf({ term: "building permit for a garden room", language: "en" })?.kind).toBe("regulation");
    expect(factRiskOf({ term: "boiler grant scheme", language: "en" })?.kind).toBe("incentive");
  });
  it("does not read the field's own words as a claim: a profession, a condition, a treatment", () => {
    expect(factRiskOf({ term: "dentist for sensitive teeth", language: "en" })).toBeNull();
    expect(factRiskOf({ term: "tooth pain when chewing", angle: "Tooth pain when chewing: causes and when to see a dentist", language: "en" })).toBeNull();
    expect(factRiskOf({ term: "stiff shoulder in the morning", language: "en" })).toBeNull();
    expect(factRiskOf({ term: "dental clinic for patients with anxiety", language: "en" })).toBeNull();
    // The claim is: how long it takes to heal.
    expect(factRiskOf({ term: "how long to heal after a tooth extraction", language: "en" })?.kind).toBe("health");
  });
});
