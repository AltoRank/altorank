import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeDb } from "./fake-runs-client";
import { EMPTY_PROFILE } from "../profile-shape";
const { state, infer, auth, spend } = vi.hoisted(() => ({ state: { db: null as FakeDb | null }, infer: vi.fn(), auth: vi.fn(), spend: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db!.client }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: (...a: unknown[]) => auth(...a) }));
vi.mock("@/lib/billing/spend-gate", () => ({ canSpend: (...a: unknown[]) => spend(...a) }));
vi.mock("@/lib/onboarding/observed-facts", () => ({ inferVerifiedBusinessProfile: (...a: unknown[]) => infer(...a) }));
vi.mock("@/lib/onboarding/site-discovery", () => ({ discoverSite: async () => ({ sitemapUrl: "https://studio.example/sitemap.xml", blogRootUrl: null, exampleArticleUrls: [], found: true }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { clarifyFirstLookOffering, prepareAutomaticFirstLook } from "@/app/actions/onboarding-wizard";

const profile = { ...EMPTY_PROFILE, name: "Studio", description: "Builds mobile applications for business owners.", offerings: ["Mobile app development"] };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("AUTOMATIC_FIRST_LOOK_WORKSPACES", "ws1");
  state.db = fakeDb({ workspaces: [{ id: "ws1", name: "studio.example", domain: "studio.example", business_profile: null },
    { id: "ws2", name: "other.example", domain: "other.example", business_profile: null }] });
  auth.mockResolvedValue({ accountId: "a1", user: { id: "u1", email: "owner@example.test" } });
  spend.mockResolvedValue({ allowed: true });
  infer.mockResolvedValue({ profile, reason: "ok", source: "static" });
});
describe("automatic profile preparation", () => {
  it("persists inference and discovered links without inventing owner confirmation", async () => {
    await prepareAutomaticFirstLook("ws1");
    const row = state.db!.tables.workspaces[0];
    expect(row.business_profile).toEqual(profile);
    expect(row.sitemap_url).toBe("https://studio.example/sitemap.xml");
    expect(state.db!.tables.workspaces[1].business_profile).toBeNull();
    expect(auth).toHaveBeenCalledWith(undefined, { workspaceId: "ws1" });
  });
  it("reuses saved profile and preserves owner confirmation on repeat visits", async () => {
    state.db!.tables.workspaces[0].business_profile = { ...profile, confirmedAt: "2026-09-01T00:00:00.000Z" };
    await prepareAutomaticFirstLook("ws1");
    expect(infer).not.toHaveBeenCalled();
    expect(state.db!.tables.workspaces[0].business_profile).toMatchObject({ confirmedAt: "2026-09-01T00:00:00.000Z" });
  });
  it("requires both rollout membership and the spend gate before reading a site", async () => {
    await expect(prepareAutomaticFirstLook("ws2")).rejects.toThrow("not enabled");
    spend.mockResolvedValue({ allowed: false, message: "Setup allowance used." });
    expect(await prepareAutomaticFirstLook("ws1")).toMatchObject({ profile: null, reason: "needs_plan" });
    expect(infer).not.toHaveBeenCalled();
  });
  it("stores a one-field clarification without confirming all inferred facts", async () => {
    state.db!.tables.workspaces[0].business_profile = profile;
    await clarifyFirstLookOffering("ws1", "Mobile app development");
    expect(state.db!.tables.workspaces[0].business_profile).toEqual({ ...profile, firstLookOffering: "Mobile app development" });
    expect(state.db!.tables.workspaces[1].business_profile).toBeNull();
  });
});
