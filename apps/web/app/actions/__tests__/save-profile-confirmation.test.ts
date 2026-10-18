import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// A stamped profile tells the writer "the owner's confirmed words" and the
// first look "the competitor you named". The wizard's auto-start used the
// same save as the button, so a profile a model read off the site, which
// nobody had looked at, went out stamped (2026-10-16).

const writes: Record<string, unknown>[] = [];

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: async () => ({ accountId: "acc-1", role: "owner", user: { id: "u1" } }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { id: "ws-1", domain: "example.com", name: "example.com" }, error: null }) }) }),
      update: (values: Record<string, unknown>) => {
        writes.push(values);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

const PROFILE = { name: "Example", description: "Roofing", audiences: [], offerings: ["flat roofs"], competitors: [], language: "en", country: "GB" };

let saveProfile: typeof import("../onboarding-wizard").saveProfile;
beforeAll(async () => {
  ({ saveProfile } = await import("../onboarding-wizard"));
}, 30_000);

beforeEach(() => {
  writes.length = 0;
});

describe("saveProfile", () => {
  it("stamps the profile when a person saves it", async () => {
    await saveProfile("ws-1", PROFILE as never);
    const saved = writes[0].business_profile as { confirmedAt: unknown };
    expect(typeof saved.confirmedAt).toBe("string");
  });

  it("does not stamp it when the run started by itself, even if the client sent a stamp", async () => {
    await saveProfile("ws-1", { ...PROFILE, confirmedAt: "2026-10-16T10:00:00Z" } as never, { auto: true });
    const saved = writes[0].business_profile as { confirmedAt: unknown; offerings: unknown };
    expect(saved.confirmedAt).toBeNull();
    expect(saved.offerings).toEqual(["flat roofs"]);
  });
});
