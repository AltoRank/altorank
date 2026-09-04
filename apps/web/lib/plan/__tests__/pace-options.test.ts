import { describe, it, expect } from "vitest";
import { describePace, paceAllowed, paceOptions, planNeededFor, PACE_OPTIONS } from "../pace-options";

describe("paceOptions", () => {
  it("offers the paces people mean, in words", () => {
    expect(PACE_OPTIONS).toEqual([1, 2, 3, 5, 7, 14, 21]);
    expect(describePace(7)).toBe("one a day");
    expect(describePace(14)).toBe("two a day");
    expect(describePace(21)).toBe("three a day");
    expect(describePace(3)).toBe("3 a week");
  });
  it("lets an unmetered account pick anything", () => {
    for (const o of paceOptions({ limit: null, reason: "self-host" })) expect(o.allowed).toBe(true);
    for (const o of paceOptions({ limit: null, reason: "operator" })) expect(o.allowed).toBe(true);
  });
  it("on Managed (100 a month) allows up to three a day and says so in months", () => {
    const opts = paceOptions({ limit: 100, reason: "plan" });
    expect(opts.find((o) => o.pace === 21)).toMatchObject({ allowed: true, monthly: 91, meaning: "about 91 articles a month" });
  });
  it("with no plan, only the free-tier pace is available and the rest name the plan", () => {
    const opts = paceOptions({ limit: 1, reason: "no-plan" });
    expect(opts.find((o) => o.pace === 1)?.allowed).toBe(true);
    expect(opts.find((o) => o.pace === 7)).toMatchObject({ allowed: false, needsPlan: "starter", needsPlanLabel: "Managed" });
  });
  it("names the cheapest tier that covers the volume", () => {
    expect(planNeededFor(30)).toBe("starter");
    expect(planNeededFor(100)).toBe("starter");
    expect(planNeededFor(101)).toBe("growth");
    expect(planNeededFor(400)).toBe("growth");
    expect(planNeededFor(401)).toBe("scale");
  });
  it("refuses paces the column cannot hold", () => {
    expect(paceAllowed(26, { limit: null, reason: "self-host" })).toBe(false);
    expect(paceAllowed(-1, { limit: null, reason: "self-host" })).toBe(false);
  });
});
