import { describe, it, expect } from "vitest";
import { siteSlotsLabel, siteSlotsRemaining } from "@/lib/workspaces/slots";
import { siteAllowanceFrom } from "@/lib/workspaces/allowance";
import type { Quota } from "@/lib/billing/quota";

const q = (reason: Quota["reason"], plan: Quota["plan"] = null): Quota => ({
  limit: null,
  used: 0,
  remaining: null,
  reason,
  plan,
});

describe("siteAllowanceFrom", () => {
  it("is unknown when there is no quota to read", () => {
    expect(siteAllowanceFrom(null, 2)).toBeNull();
  });

  it("has no ceiling for self-host and operators", () => {
    expect(siteAllowanceFrom(q("self-host"), 4)).toEqual({ used: 4, limit: null });
    expect(siteAllowanceFrom(q("operator"), 9)).toEqual({ used: 9, limit: null });
  });

  it("reads the tier's limit on a plan and one site before a plan", () => {
    expect(siteAllowanceFrom(q("plan", "starter"), 2)).toEqual({ used: 2, limit: 3 });
    expect(siteAllowanceFrom(q("plan", "growth"), 12)).toEqual({ used: 12, limit: null });
    expect(siteAllowanceFrom(q("no-plan"), 1)).toEqual({ used: 1, limit: 1 });
  });
});

describe("siteSlotsLabel", () => {
  it("says a dash when nobody knows, never a zero", () => {
    expect(siteSlotsLabel(null)).toBe("—");
  });

  it("counts against the plan", () => {
    expect(siteSlotsLabel({ used: 2, limit: 3 })).toBe("2 of 3 sites used");
    expect(siteSlotsLabel({ used: 1, limit: 1 })).toBe("1 of 1 site used");
  });

  it("says so when there is no limit", () => {
    expect(siteSlotsLabel({ used: 1, limit: null })).toBe("1 site, no limit");
    expect(siteSlotsLabel({ used: 5, limit: null })).toBe("5 sites, no limit");
  });
});

describe("siteSlotsRemaining", () => {
  it("is null without a ceiling and never negative with one", () => {
    expect(siteSlotsRemaining(null)).toBeNull();
    expect(siteSlotsRemaining({ used: 3, limit: null })).toBeNull();
    expect(siteSlotsRemaining({ used: 1, limit: 3 })).toBe(2);
    expect(siteSlotsRemaining({ used: 5, limit: 3 })).toBe(0);
  });
});
