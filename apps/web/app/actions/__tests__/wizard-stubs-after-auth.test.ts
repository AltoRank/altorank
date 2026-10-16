import { describe, it, expect, vi, afterEach } from "vitest";

// The E2E_STUBS switch replaces paid calls with fixtures. It must never skip
// the auth check: the competitor lookups answered with fixtures before
// requireAuth ran, unlike every other stubbed entry point.

const requireAuth = vi.fn(async () => {
  throw new Error("Not a member of this site.");
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { id: "ws-1", domain: "example.com" }, error: null }) }) }),
    }),
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  requireAuth.mockClear();
});

const profile = { name: "Example", language: "en", country: "us" } as never;

describe("competitor lookups under E2E_STUBS", () => {
  it("suggestCompetitors checks auth before answering with a fixture", async () => {
    vi.stubEnv("E2E_STUBS", "1");
    const { suggestCompetitors } = await import("../onboarding-wizard");
    await expect(suggestCompetitors("ws-1", profile)).rejects.toThrow(/Not a member/);
    expect(requireAuth).toHaveBeenCalledOnce();
  });

  it("resolveCompetitor checks auth before answering with a fixture", async () => {
    vi.stubEnv("E2E_STUBS", "1");
    const { resolveCompetitor } = await import("../onboarding-wizard");
    await expect(resolveCompetitor("ws-1", "rival", null)).rejects.toThrow(/Not a member/);
    expect(requireAuth).toHaveBeenCalledOnce();
  });
});
