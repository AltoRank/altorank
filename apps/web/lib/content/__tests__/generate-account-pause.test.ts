import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * An account pause has to stop generation, not only collection.
 *
 * The pause on the Billing page writes `status = 'paused'` and `paused_until`
 * on every workspace and tells Stripe `pause_collection` - so the invoices are
 * voided. The promise beside the buttons is two-sided: "Billing and article
 * generation pause" (PAUSE_COPY) and "Nothing is drafted or billed until
 * then" (the retention card). Only Stripe's half was kept.
 *
 * Verified against the running app on 2026-09-06: POST
 * /api/agent/v1/articles/generate with a site paused until October returned
 * 200 and a draft. "Write now" reaches the same function. So for the length of
 * a three-month pause an account we had deliberately stopped charging kept
 * spending our model and data budget.
 *
 * The gate is `paused_until`, not `status` alone. "Pause this site" sets only
 * the status and documents itself as "not now" for the scheduled jobs - every
 * cron filters it, and a person who then presses Write now is asking on
 * purpose. That difference is what these tests hold.
 */

const getQuota = vi.fn();
vi.mock("@/lib/billing/quota", () => ({
  getQuota: (...args: unknown[]) => getQuota(...args),
  quotaExceededMessage: () => "quota exceeded",
}));

// Module level, for the reason generate-quota-caller.test.ts records: importing
// generate.ts pulls in the whole AI and SEO tree and blows a test's clock.
import { generateArticle } from "../generate";

/** Enough client to reach the gates and no further. */
function client(row: Record<string, unknown>) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              id: "ws1",
              agency_id: "agency1",
              ai_provider: null,
              ai_model: null,
              language: null,
              brand_style: null,
              location_code: null,
              ...row,
            },
            error: null,
          }),
        }),
      }),
    }),
  } as never;
}

const PLENTY = { limit: 100, used: 0, remaining: 100, reason: "plan", plan: "starter" };

beforeEach(() => {
  getQuota.mockReset();
  getQuota.mockResolvedValue(PLENTY);
});

async function attempt(row: Record<string, unknown>) {
  return generateArticle({
    supabase: client(row),
    workspaceId: "ws1",
    keyword: "anything",
    callerEmail: null,
  });
}

describe("the account pause stops generation", () => {
  it("refuses a draft while the pause is on, with the date and the way out", async () => {
    await expect(attempt({ status: "paused", paused_until: "2026-12-01" })).rejects.toThrow(
      /paused until December 1, 2026/,
    );
    // The refusal is about the pause, not the plan: this account has 100 of
    // 100 articles left, and telling them to upgrade would be nonsense.
    await expect(attempt({ status: "paused", paused_until: "2026-12-01" })).rejects.toThrow(
      /nothing is billed until then/,
    );
  });

  it("refuses before the quota is even read, so a pause needs no allowance", async () => {
    // A paused account with its month spent must not get the quota message;
    // and one with room must not get through on the strength of it.
    await expect(attempt({ status: "paused", paused_until: "2026-12-01" })).rejects.toThrow(/paused/);
    expect(getQuota).not.toHaveBeenCalled();
  });

  it("leaves a site paused by hand alone", async () => {
    // "Pause this site" writes the status and no date. It means "not now" to
    // the crons, which filter it themselves; a person pressing Write now on
    // that site is asking deliberately and has always been allowed to.
    // Getting past the gate is all this asserts - the call goes on to a model
    // and fails there.
    await expect(attempt({ status: "paused", paused_until: null })).rejects.not.toThrow(/paused until/);
    expect(getQuota).toHaveBeenCalled();
  });

  it("leaves a resumed site alone once the status is back to on", async () => {
    // resumePausedWorkspaces clears both fields together, but a stale
    // `paused_until` on an active site must not keep refusing.
    await expect(attempt({ status: "on", paused_until: "2026-01-01" })).rejects.not.toThrow(/paused until/);
    expect(getQuota).toHaveBeenCalled();
  });
});
