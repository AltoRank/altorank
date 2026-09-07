import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// One rule about pace, not two
// ---------------------------------------------------------------------------
//
// Two controls set how fast a site writes. The Articles-plan popover on the
// calendar offers a list and checks it (`paceAllowed`, lib/plan/pace-options.ts):
// on a free account it refuses 25 a week with "Needs the Managed plan". The
// slider in workspace settings ran to MAX_PACE on every tier, and the action
// behind it wrote whatever arrived.
//
// So the same setting had two answers, and the honest one only appeared on
// whichever screen happened to check. 25 a week is about 108 a month against
// seven free drafts - the generator would then refuse every article after the
// seventh, from a site whose own settings said it was writing 25.

const updates: Record<string, unknown>[] = [];

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      update: (row: Record<string, unknown>) => {
        updates.push(row);
        // .eq("id", …).eq("agency_id", …): the action scopes the write to the
        // agency as well as the id, since the id arrives from the browser.
        return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
      },
    }),
  }),
}));

const { requireAuth, getQuota } = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => ({ agencyId: "agency-1", role: "owner", user: { id: "u1", email: "a@b.co" } })),
  getQuota: vi.fn(),
}));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth }));
vi.mock("@/lib/billing/quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/quota")>();
  return { ...actual, getQuota };
});

async function setPace(pace: unknown) {
  const { setGenerationPace } = await import("../workspaces");
  return setGenerationPace("ws1", pace);
}

beforeEach(() => {
  updates.length = 0;
  getQuota.mockReset();
  requireAuth.mockClear();
});

describe("setGenerationPace", () => {
  it("refuses a free account the 25 a week the slider used to offer", async () => {
    getQuota.mockResolvedValue({ limit: 7, used: 0, remaining: 7, reason: "no-plan", plan: null });
    // The refusal names the arithmetic and the tier that would allow it,
    // because "25" and "7 a month" are not obviously the same conversation.
    await expect(setPace(25)).rejects.toThrow(/25 a week is about \d+ a month/);
    await expect(setPace(25)).rejects.toThrow(/plan/);
    expect(updates).toHaveLength(0);
  });

  it("allows the free tier's own week", async () => {
    getQuota.mockResolvedValue({ limit: 7, used: 0, remaining: 7, reason: "no-plan", plan: null });
    await setPace(1);
    expect(updates).toEqual([{ auto_generate_weekly_limit: 1 }]);
  });

  it("lets a Managed account up to what 100 a month allows and no further", async () => {
    getQuota.mockResolvedValue({ limit: 100, used: 0, remaining: 100, reason: "plan", plan: "starter" });
    await setPace(20);
    expect(updates).toEqual([{ auto_generate_weekly_limit: 20 }]);
    await expect(setPace(25)).rejects.toThrow(/Agency plan/);
  });

  it("never meters an unmetered account", async () => {
    // Self-host pays its own provider bills; inventing a ceiling would break
    // the open-source promise.
    getQuota.mockResolvedValue({ limit: null, used: 0, remaining: null, reason: "self-host", plan: null });
    await setPace(25);
    expect(updates).toEqual([{ auto_generate_weekly_limit: 25 }]);
  });

  it("still refuses a number that is not a pace at all", async () => {
    getQuota.mockResolvedValue({ limit: null, used: 0, remaining: null, reason: "self-host", plan: null });
    await expect(setPace(99)).rejects.toThrow(/between 0 and 25/);
    expect(updates).toHaveLength(0);
  });
});
