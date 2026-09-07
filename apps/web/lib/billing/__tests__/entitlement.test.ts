import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * The crons that buy something per site on the account's behalf, and so
 * have to ask. Read from the source, like lib/plan/__tests__/cron-pause-guard:
 * the routes are not callable from vitest and the gate is one call that is
 * easy to leave out. `reports` was the one without it until 2026-09-07 - a
 * PDF render, an upload and a mail per month for accounts that never chose a
 * plan.
 */
describe("the paid crons gate on entitledToScheduledWork", () => {
  const CRON_DIR = join(__dirname, "..", "..", "..", "app", "api", "cron");
  it.each(["serp", "geo", "reports"])("%s", (route) => {
    const src = readFileSync(join(CRON_DIR, route, "route.ts"), "utf8");
    expect(src).toContain("entitledToScheduledWork(");
  });
});
