import { describe, it, expect } from "vitest";
import { entitledToScheduledWork, type Quota } from "../quota";

const q = (reason: Quota["reason"], over: Partial<Quota> = {}): Quota => ({
  limit: null, used: 0, remaining: null, reason, plan: null, ...over,
});

describe("entitledToScheduledWork", () => {
  it("refuses only the account with no plan", () => {
    expect(entitledToScheduledWork(q("no-plan", { limit: 1, remaining: 1 }))).toBe(false);
  });

  it("always runs on a self-hosted install", () => {
    // That install pays its own provider bills. Gating it would break the
    // open-source promise, and there is no plan there to check.
    expect(entitledToScheduledWork(q("self-host"))).toBe(true);
  });

  it("runs for a paying account and for an operator", () => {
    expect(entitledToScheduledWork(q("plan", { limit: 100, remaining: 40, plan: "starter" }))).toBe(true);
    expect(entitledToScheduledWork(q("operator"))).toBe(true);
  });

  it("keeps running for a paying account that is out of articles", () => {
    // Out of quota stops NEW drafts, not the tracking of what already shipped.
    // Their published articles must keep being measured.
    expect(entitledToScheduledWork(q("plan", { limit: 100, used: 100, remaining: 0, plan: "starter" }))).toBe(true);
  });

  it("refuses the free account even while its free draft is unused", () => {
    // The draft is free; the standing subscription to DataForSEO is not.
    expect(entitledToScheduledWork(q("no-plan", { limit: 1, used: 0, remaining: 1 }))).toBe(false);
  });
});
