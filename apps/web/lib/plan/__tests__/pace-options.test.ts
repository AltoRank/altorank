import { describe, it, expect } from "vitest";
import { describePace, maxAllowedPace, paceAllowed, paceMeaning, paceOptions, planNeededFor, PACE_OPTIONS } from "../pace-options";
import { FREE_TIER_PACE, MAX_PACE, monthlyFromPace } from "@/lib/content/pace";

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
  it("with no plan, the free week is available and anything past it names the plan", () => {
    // FREE_DRAFTS is 7, so a no-plan account may run at up to 7 a week: that is
    // how the seven free drafts land inside the first week instead of over
    // seven of them. The quota still stops it at 7 articles; the pace only sets
    // how fast the entitlement is spent.
    const opts = paceOptions({ limit: 7, reason: "no-plan" });
    expect(opts.find((o) => o.pace === 1)?.allowed).toBe(true);
    expect(opts.find((o) => o.pace === 7)?.allowed).toBe(true);
    expect(opts.find((o) => o.pace === 14)).toMatchObject({ allowed: false, needsPlan: "starter" });
  });
  it("never quotes a free account a monthly figure the quota refuses", () => {
    // The bug: every selectable pace quoted monthlyFromPace() alone, so 2, 3,
    // 5 and 7 a week read "about 9 / 13 / 22 / 30 articles a month" to an
    // account entitled to seven all month.
    const opts = paceOptions({ limit: 7, reason: "no-plan" });
    const allowed = opts.filter((o) => o.allowed);
    expect(allowed.map((o) => o.pace)).toEqual([1, 2, 3, 5, 7]);
    for (const o of allowed) {
      if (o.monthly > 7) expect(o.meaning).not.toContain(`${o.monthly} articles a month`);
    }
    // One a week does fit inside the allowance, so it keeps the plain figure.
    expect(opts.find((o) => o.pace === 1)?.meaning).toBe("about 4 articles a month");
    expect(opts.find((o) => o.pace === 7)?.meaning).toBe("the 7 free drafts, in about 7 days");
    expect(opts.find((o) => o.pace === 2)?.meaning).toBe("the 7 free drafts, in about 25 days");
  });
  it("keeps the monthly figure on options that are arguing for a plan", () => {
    // A refused row's job is to say what the plan would deliver, beside its
    // "Needs the … plan" link, so it keeps the arithmetic.
    const opts = paceOptions({ limit: 7, reason: "no-plan" });
    expect(opts.find((o) => o.pace === 14)?.meaning).toBe("about 61 articles a month");
  });
  it("leaves paid and unmetered accounts on the plain monthly figure", () => {
    for (const o of paceOptions({ limit: 400, reason: "plan" })) {
      expect(o.meaning).toBe(`about ${o.monthly} articles a month`);
    }
    for (const o of paceOptions({ limit: null, reason: "self-host" })) {
      expect(o.meaning).toBe(`about ${o.monthly} articles a month`);
    }
  });
  it("paceMeaning leaves a paused site alone", () => {
    expect(paceMeaning(0, 0, { limit: 7, reason: "no-plan" })).toBe("about 0 articles a month");
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

describe("maxAllowedPace", () => {
  // The workspace-settings slider ran to MAX_PACE on every tier and the action
  // behind it wrote whatever arrived, while the calendar's own pace control
  // one click away refused the same number. One rule, two doors.
  it("stops a free account at the free week", () => {
    expect(maxAllowedPace({ limit: 7, reason: "no-plan" })).toBe(FREE_TIER_PACE);
  });

  it("stops Managed where 100 a month does", () => {
    const max = maxAllowedPace({ limit: 100, reason: "plan" });
    expect(monthlyFromPace(max)).toBeLessThanOrEqual(100);
    expect(monthlyFromPace(max + 1)).toBeGreaterThan(100);
  });

  it("lets Account and unmetered accounts run to the column's ceiling", () => {
    expect(maxAllowedPace({ limit: 400, reason: "plan" })).toBe(MAX_PACE);
    expect(maxAllowedPace({ limit: null, reason: "self-host" })).toBe(MAX_PACE);
    expect(maxAllowedPace({ limit: null, reason: "operator" })).toBe(MAX_PACE);
  });

  it("agrees with paceAllowed at the boundary, which is the point", () => {
    for (const quota of [
      { limit: 7, reason: "no-plan" as const },
      { limit: 100, reason: "plan" as const },
      { limit: 400, reason: "plan" as const },
    ]) {
      const max = maxAllowedPace(quota);
      expect(paceAllowed(max, quota)).toBe(true);
      if (max < MAX_PACE) expect(paceAllowed(max + 1, quota)).toBe(false);
    }
  });
});
