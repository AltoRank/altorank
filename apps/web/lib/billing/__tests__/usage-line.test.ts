import { describe, it, expect } from "vitest";
import { usageLine } from "@/lib/billing/usage-line";
import { nextResetDate, quotaExceededMessage, FREE_DRAFTS, type Quota } from "@/lib/billing/quota";

const NOW = new Date("2026-09-06T12:00:00Z");

function quota(over: Partial<Quota>): Quota {
  const base: Quota = { limit: 7, used: 0, remaining: 7, reason: "no-plan", plan: null };
  const q = { ...base, ...over };
  q.remaining = q.limit === null ? null : Math.max(0, q.limit - q.used);
  return q;
}

describe("nextResetDate", () => {
  it("is the 1st of next month in UTC, which is where used is counted from", () => {
    expect(nextResetDate(NOW).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("rolls the year over in December", () => {
    expect(nextResetDate(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("usageLine, free account", () => {
  it("does not tell a brand-new account to subscribe before anything is blocked", () => {
    const line = usageLine(quota({ used: 0 }), NOW);
    expect(line.figure).toBe("0 / 7");
    // The bug: "Subscribe to generate articles" was shown at 0 / 7, while the
    // real gate is remaining <= 0 and the next seven generations succeed.
    expect(line.sentence).not.toMatch(/subscribe to generate/i);
    expect(line.sentence).toContain("7 left");
    // The allowance is one-time, and the bar is the one place a person reads
    // the number: it has to say so rather than implying a monthly refill.
    expect(line.sentence).toContain("one-time");
    expect(line.exhausted).toBe(false);
  });

  it("calls them free drafts, not included articles, and never 'this month'", () => {
    // "Included articles" is the phrase the paid tiers use for 100 and 400.
    // "This month" was true until migration 083 and is not any more.
    expect(usageLine(quota({ used: 3 }), NOW).sentence).toContain("free drafts used");
    expect(usageLine(quota({ used: 3 }), NOW).sentence).not.toContain("included articles");
    expect(usageLine(quota({ used: 3 }), NOW).sentence).not.toContain("this month");
  });

  it("says the allowance is one-time once it is spent, and names no reset", () => {
    const line = usageLine(quota({ used: 7 }), NOW);
    expect(line.figure).toBe("7 / 7");
    expect(line.sentence).toMatch(/one-time/);
    expect(line.sentence).toMatch(/choose a plan/i);
    expect(line.sentence).not.toContain("Oct 1");
    expect(line.exhausted).toBe(true);
    expect(line.fraction).toBe(1);
  });

  it("does not read '150 / 7' after a cancellation", () => {
    // getQuota drops a cancelled account to FREE_DRAFTS while `used` stays
    // its lifetime count, so the two numbers stop being a ratio.
    const line = usageLine(quota({ used: 150 }), NOW);
    expect(line.figure).toBe("150");
    expect(line.sentence).toContain("The free allowance of 7 is used");
    expect(line.sentence).not.toContain("Oct 1");
    expect(line.fraction).toBe(1);
  });
});

describe("usageLine, paid account", () => {
  it("states the included volume plainly under the limit", () => {
    const line = usageLine(quota({ limit: 400, used: 120, reason: "plan", plan: "growth" }), NOW);
    expect(line.figure).toBe("120 / 400");
    expect(line.sentence).toBe("included articles used.");
    expect(line.fraction).toBeCloseTo(0.3);
    expect(line.exhausted).toBe(false);
  });

  it("mentions overage only once the included volume is gone", () => {
    const under = usageLine(quota({ limit: 100, used: 99, reason: "plan", plan: "starter" }), NOW);
    expect(under.sentence).not.toMatch(/overage/);
    const at = usageLine(quota({ limit: 100, used: 100, reason: "plan", plan: "starter" }), NOW);
    expect(at.sentence).toMatch(/overage/);
    // Never over 100% of the bar.
    expect(at.fraction).toBe(1);
  });

  it("says what a downgrade did instead of printing 150 / 100", () => {
    // Agency -> Managed mid-month: the 150 written under the old tier stay,
    // and the included volume is now 100. "150 / 100" is arithmetic nobody
    // can read - the same fault the free branch already refuses.
    const line = usageLine(quota({ limit: 100, used: 150, reason: "plan", plan: "starter" }), NOW);
    expect(line.figure).toBe("150");
    expect(line.sentence).toContain("includes 100");
    expect(line.sentence).toContain("already written stay");
    expect(line.exhausted).toBe(true);
    expect(line.fraction).toBe(1);
  });

  it("does not promise the scheduled writer will bill overage", () => {
    // The cron refuses past the included volume; only a person can spend the
    // overage (lib/content/generate.ts).
    const at = usageLine(quota({ limit: 100, used: 100, reason: "plan", plan: "starter" }), NOW);
    expect(at.sentence).toContain("Scheduled writing stops");
    expect(at.sentence).toContain("by hand");
  });
});

describe("usageLine, unmetered", () => {
  it("has no bar and names which kind of unmetered", () => {
    const selfHost = usageLine(
      { limit: null, used: 42, remaining: null, reason: "self-host", plan: null },
      NOW,
    );
    expect(selfHost.figure).toBe("42");
    expect(selfHost.sentence).toContain("(self-host)");
    expect(selfHost.fraction).toBeNull();

    const operator = usageLine(
      { limit: null, used: 9, remaining: null, reason: "operator", plan: null },
      NOW,
    );
    expect(operator.sentence).toContain("(operator)");
  });
});

describe("quotaExceededMessage", () => {
  it("names the two ways out of the free allowance, and no reset date", () => {
    const msg = quotaExceededMessage(quota({ used: FREE_DRAFTS }), NOW);
    expect(msg).toContain("7 free drafts");
    expect(msg).toContain("Billing page");
    expect(msg).toMatch(/self-host/i);
    // One-time since migration 083: waiting is no longer a way through.
    expect(msg).not.toContain("Oct 1");
  });

  it("no longer says 'the free draft', singular", () => {
    expect(quotaExceededMessage(quota({ used: 7 }), NOW)).not.toContain("The free draft is used");
  });

  it("tells a paid account at its limit what actually stops, and when", () => {
    // This branch is only ever read by the scheduled writer: a manual
    // generation past the included volume bills the overage rather than
    // refusing, so it never reaches here. It used to say "the next article is
    // billed as overage", which is the one thing the cron will never do.
    const msg = quotaExceededMessage(
      quota({ limit: 100, used: 100, reason: "plan", plan: "starter" }),
      NOW,
    );
    expect(msg).toContain("included 100 articles");
    expect(msg).toContain("Scheduled writing stops");
    expect(msg).toContain("Oct 1");
    expect(msg).not.toContain("The next article is billed as overage");
    // The overage is still the way through, named as the human action it is.
    expect(msg).toContain("by hand" );
  });
});
