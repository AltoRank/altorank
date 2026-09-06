import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The quota gate inside generateArticle must reach the same verdict as the
 * gate its caller already ran.
 *
 * It did not. cron/generate asked `getQuota(client, agencyId, null)` - null
 * meaning "there is no session here, this is a cron" - and generateArticle
 * asked `getQuota(client, agencyId)` with the argument omitted, which means
 * "go and resolve one". On a service client that resolves to nobody while
 * still counting as a session, so the operator's own agency came back
 * "operator, unlimited" from the first call and "no-plan, free draft used"
 * from the second. Every run logged an error for a condition the cron route
 * deliberately calls a skip.
 *
 * The distinction is invisible at the type level - `undefined` and `null` are
 * both assignable to `userEmail?: string | null` - so it is pinned here.
 */

const getQuota = vi.fn();
vi.mock("@/lib/billing/quota", () => ({
  getQuota: (...args: unknown[]) => getQuota(...args),
  quotaExceededMessage: () => "The free draft is used.",
}));

// Imported here, not inside the first test. generate.ts pulls in the whole
// AI, SEO and billing tree, and transforming that on a loaded worker took
// longer than a test's 5s budget - the file timed out on main in two
// independent full-suite runs on 2026-09-04 and passed alone every time. At
// module level the cost lands on collection, which has no such clock.
// `vi.mock` is hoisted above this line, so the mock is in place before the
// import runs.
import { generateArticle } from "../generate";

/** Enough client to reach the quota gate and no further. */
function client() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { id: "ws1", agency_id: "agency1", ai_provider: null, ai_model: null,
                    language: null, brand_style: null, location_code: null },
            error: null,
          }),
        }),
      }),
    }),
  } as never;
}

/** Out of quota, so the call throws at the gate instead of reaching a model. */
const EXHAUSTED = { limit: 1, used: 1, remaining: 0, reason: "no-plan", plan: null };

beforeEach(() => {
  getQuota.mockReset();
  getQuota.mockResolvedValue(EXHAUSTED);
});

describe("generateArticle quota gate", () => {
  it("forwards an explicit null, so a cron is judged sessionless", async () => {
    await expect(
      generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "k",
                        autonomous: true, callerEmail: null }),
    ).rejects.toThrow();

    expect(getQuota).toHaveBeenCalledOnce();
    const [, agencyId, caller] = getQuota.mock.calls[0];
    expect(agencyId).toBe("agency1");
    expect(caller).toBeNull();
  });

  it("passes undefined when the caller has a session to resolve", async () => {
    await expect(
      generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "k",
                        autonomous: true }),
    ).rejects.toThrow();

    const [, , caller] = getQuota.mock.calls[0];
    expect(caller).toBeUndefined();
  });

  /**
   * The reason `autonomous` cannot stand in for "sessionless": onboarding and
   * the exchange both set it from inside a user's request, and giving them the
   * cron's answer would hand an operator bypass to whoever is onboarding.
   */
  it("does not infer sessionlessness from autonomous", async () => {
    await expect(
      generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "k",
                        autonomous: true }),
    ).rejects.toThrow();
    expect(getQuota.mock.calls[0][2]).not.toBeNull();
  });
});
