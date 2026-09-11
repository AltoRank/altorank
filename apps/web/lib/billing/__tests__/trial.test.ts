import { describe, expect, it } from "vitest";
import { trialEligible, trialEndsLabel, trialGateApplies, trialGateBypassed, trialInfo } from "@/lib/billing/trial";
import { planEntitled } from "@/lib/billing/dunning";

describe("trialEligible", () => {
  it("is true for a fresh account", () => {
    expect(trialEligible({ plan_status: "inactive" })).toBe(true);
    expect(trialEligible(null)).toBe(true);
  });
  it("is false once the account has had its trial, whatever happened after", () => {
    expect(trialEligible({ plan_status: "inactive", trial_ends_at: "2026-09-16T00:00:00Z" })).toBe(false);
    expect(trialEligible({ plan_status: "canceled", trial_ends_at: "2026-09-16T00:00:00Z" })).toBe(false);
  });
  it("is false while a subscription exists", () => {
    expect(trialEligible({ plan_status: "active", stripe_subscription_id: "sub_1" })).toBe(false);
    expect(trialEligible({ plan_status: "trialing", stripe_subscription_id: "sub_1" })).toBe(false);
  });
});

describe("trialInfo", () => {
  const now = new Date("2026-09-09T12:00:00Z");
  it("counts whole days left, never negative", () => {
    expect(trialInfo({ plan_status: "trialing", trial_ends_at: "2026-09-16T12:00:00Z" }, now)?.daysLeft).toBe(7);
    expect(trialInfo({ plan_status: "trialing", trial_ends_at: "2026-09-10T00:00:00Z" }, now)?.daysLeft).toBe(1);
    expect(trialInfo({ plan_status: "trialing", trial_ends_at: "2026-09-01T00:00:00Z" }, now)?.daysLeft).toBe(0);
  });
  it("is null unless the plan is a trial", () => {
    expect(trialInfo({ plan_status: "active", trial_ends_at: "2026-09-16T12:00:00Z" }, now)).toBeNull();
    expect(trialInfo({ plan_status: "trialing" }, now)).toBeNull();
  });
  it("labels the end", () => {
    expect(trialEndsLabel({ endsAt: "", daysLeft: 3 })).toBe("Trial ends in 3 days");
    expect(trialEndsLabel({ endsAt: "", daysLeft: 1 })).toBe("Trial ends tomorrow");
    expect(trialEndsLabel({ endsAt: "", daysLeft: 0 })).toBe("Trial ends today");
  });
});

describe("planEntitled during a trial", () => {
  it("treats trialing as the paid plan it is", () => {
    expect(planEntitled({ plan_status: "trialing" })).toBe(true);
  });
});

describe("trialGateApplies", () => {
  const gated = { reason: "no-plan", trialEligible: true };

  it("gates an account that has never trialed and has no plan", () => {
    expect(trialGateApplies(gated)).toBe(true);
  });

  // Each of these locks somebody out of a working product if it regresses, so
  // each is named rather than folded into one "not gated" case.
  it("never gates a self-hosted install", () => {
    // No Stripe key: there is no trial to start, and the person locked out
    // would be the operator running it.
    expect(trialGateApplies({ reason: "self-host", trialEligible: true })).toBe(false);
  });
  it("never gates an operator account", () => {
    expect(trialGateApplies({ reason: "operator", trialEligible: true })).toBe(false);
  });
  it("never gates an account already on a plan", () => {
    expect(trialGateApplies({ reason: "plan", trialEligible: false })).toBe(false);
  });
  it("never gates an account that already had its trial", () => {
    expect(trialGateApplies({ reason: "no-plan", trialEligible: false })).toBe(false);
  });
  it("does not gate when there is no quota to read", () => {
    expect(trialGateApplies(null)).toBe(false);
    expect(trialGateApplies(undefined)).toBe(false);
  });

  it("TRIAL_GATE_DISABLED turns it off without a deploy", () => {
    const before = process.env.TRIAL_GATE_DISABLED;
    process.env.TRIAL_GATE_DISABLED = "1";
    try {
      expect(trialGateApplies(gated)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.TRIAL_GATE_DISABLED;
      else process.env.TRIAL_GATE_DISABLED = before;
    }
  });
});

describe("trialGateBypassed", () => {
  const withEnv = (value: string | undefined, run: () => void) => {
    const before = process.env.TRIAL_GATE_BYPASS_EMAILS;
    if (value === undefined) delete process.env.TRIAL_GATE_BYPASS_EMAILS;
    else process.env.TRIAL_GATE_BYPASS_EMAILS = value;
    try {
      run();
    } finally {
      if (before === undefined) delete process.env.TRIAL_GATE_BYPASS_EMAILS;
      else process.env.TRIAL_GATE_BYPASS_EMAILS = before;
    }
  };

  it("covers every +tag of a listed address from one entry", () => {
    withEnv("helloaltorank@gmail.com", () => {
      expect(trialGateBypassed("helloaltorank+test@gmail.com")).toBe(true);
      expect(trialGateBypassed("helloaltorank+anything-at-all@gmail.com")).toBe(true);
      expect(trialGateBypassed("helloaltorank@gmail.com")).toBe(true);
      expect(trialGateBypassed("HelloAltoRank+Caps@Gmail.com")).toBe(true);
    });
  });

  it("does not bypass a different mailbox that merely starts the same", () => {
    withEnv("helloaltorank@gmail.com", () => {
      expect(trialGateBypassed("helloaltorank2@gmail.com")).toBe(false);
      expect(trialGateBypassed("helloaltorank@example.com")).toBe(false);
      expect(trialGateBypassed("nothelloaltorank@gmail.com")).toBe(false);
    });
  });

  // The default for an install that is not ours: nobody is exempt.
  it("exempts nobody when the variable is unset or empty", () => {
    withEnv(undefined, () => expect(trialGateBypassed("helloaltorank+test@gmail.com")).toBe(false));
    withEnv("", () => expect(trialGateBypassed("helloaltorank+test@gmail.com")).toBe(false));
    withEnv("  ,  ", () => expect(trialGateBypassed("helloaltorank+test@gmail.com")).toBe(false));
  });

  it("ignores junk input rather than matching it", () => {
    withEnv("helloaltorank@gmail.com", () => {
      expect(trialGateBypassed(null)).toBe(false);
      expect(trialGateBypassed("")).toBe(false);
      expect(trialGateBypassed("@gmail.com")).toBe(false);
      expect(trialGateBypassed("+test@gmail.com")).toBe(false);
    });
  });

  it("takes a list", () => {
    withEnv("a@x.com, b@y.com", () => {
      expect(trialGateBypassed("a+1@x.com")).toBe(true);
      expect(trialGateBypassed("b@y.com")).toBe(true);
      expect(trialGateBypassed("c@z.com")).toBe(false);
    });
  });
});
