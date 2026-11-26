import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The buyer test judges against the business profile. Workspaces older than
 * the wizard have none, and on 2026-09-14 the nightly cron stamped every one
 * of their keywords "pending" for six runs. The profile is built from the
 * site when it is missing, once, and the reason is carried when it cannot be.
 */

const infer = vi.fn();
// Partial: the site read is faked, the observed-URL field list is the real one
// (lib/onboarding/observed-facts.ts checks every field it names).
vi.mock("@/lib/onboarding/business-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/onboarding/business-profile")>()),
  inferBusinessProfileDetailed: (...a: unknown[]) => infer(...a),
}));

import { ensureBusinessProfile, profileFromAnswer, profileUsable } from "../business-context";

const updates: Array<{ table: string; patch: unknown; id: string }> = [];
const db = {
  from: (table: string) => ({
    update: (patch: unknown) => ({ eq: async (_k: string, id: string) => { updates.push({ table, patch, id }); return { error: null }; } }),
  }),
} as never;

const PROPOSED = {
  name: "Qasimcode", language: "English", country: "Global (English)",
  description: "Qasimcode builds appointment-based websites for clinics, salons and studios.",
  audiences: ["Dental clinics"], offerings: ["clinic booking websites"], competitors: ["calendly.com"],
};

beforeEach(() => { infer.mockReset(); updates.length = 0; });

describe("profileUsable", () => {
  it("needs a real description, not a stub", () => {
    expect(profileUsable(null)).toBe(false);
    expect(profileUsable({ description: "" })).toBe(false);
    expect(profileUsable({ description: "SEO tool" })).toBe(false);
    expect(profileUsable({ description: PROPOSED.description })).toBe(true);
  });
});

describe("ensureBusinessProfile", () => {
  it("passes a usable profile through without reading the site", async () => {
    const out = await ensureBusinessProfile(db, "ws", "qasimcode.com", { description: PROPOSED.description, audiences: ["x"] });
    expect(out).toEqual({ business: { description: PROPOSED.description, audiences: ["x"] }, inferred: false, missing: null });
    expect(infer).not.toHaveBeenCalled();
  });

  it("reads the site for a missing profile, keeps what the person had typed, and saves it", async () => {
    infer.mockResolvedValue({ profile: PROPOSED, reason: "ok", source: "static" });
    const out = await ensureBusinessProfile(db, "ws", "qasimcode.com", { competitors: ["acuityscheduling.com"], audiences: [] });
    expect(out.inferred).toBe(true);
    expect(out.missing).toBeNull();
    expect(out.business?.description).toBe(PROPOSED.description);
    expect(out.business?.competitors).toEqual(["acuityscheduling.com"]);
    expect(out.business?.audiences).toEqual(["Dental clinics"]);
    expect(updates).toEqual([{ table: "workspaces", id: "ws", patch: { business_profile: expect.objectContaining({ competitors: ["acuityscheduling.com"] }) } }]);
    // Nobody looked at it: saved as unconfirmed, so the writer is not told
    // a model's reading is the owner's word.
    expect(updates[0].patch).toMatchObject({ business_profile: { confirmedAt: null } });
  });

  it("says why when the site cannot be read for one", async () => {
    infer.mockResolvedValue({ profile: null, reason: "unreadable", source: "none" });
    const out = await ensureBusinessProfile(db, "ws", "blocked.example", null);
    expect(out.business).toBeNull();
    expect(out.missing).toBe("no business profile, and the site could not be read to build one");
    expect(updates).toEqual([]);
  });

  it("does not read anything without a domain", async () => {
    const out = await ensureBusinessProfile(db, "ws", null, null);
    expect(out.missing).toContain("no domain");
    expect(infer).not.toHaveBeenCalled();
  });

  it("infers from text the caller already holds, when the site cannot be fetched", async () => {
    // A Shopify App Store install: no wizard, and a storefront that may be
    // password-locked. The store's catalogue, read through the Admin API, is the evidence.
    infer.mockResolvedValue({ profile: PROPOSED, reason: "ok", source: "shopify" });
    const read = { text: "STORE: altorank-dev\n\nPRODUCTS (1):\n- The Hidden Snowboard - snowboard", source: "shopify" as const, chars: 60 };
    const out = await ensureBusinessProfile(db, "ws", "altorank-dev.myshopify.com", null, { read });
    expect(infer).toHaveBeenCalledWith("altorank-dev.myshopify.com", { read });
    expect(out.inferred).toBe(true);
    expect(updates).toHaveLength(1);
  });
});

describe("profileFromAnswer", () => {
  it("makes the owner's lists a usable profile, in their own words", () => {
    const built = profileFromAnswer({ name: "Sugarloft", description: "", offerings: ["wedding cakes", " celebration cakes "], audiences: ["couples planning a wedding"], confirmedAt: "2026-11-20T10:00:00Z" }, "sugarloft.example")!;
    expect(built.description).toBe("Sugarloft offers wedding cakes, celebration cakes to couples planning a wedding.");
    expect(profileUsable(built)).toBe(true);
    // Everything else they saved is kept as it was.
    expect(built).toMatchObject({ name: "Sugarloft", offerings: ["wedding cakes", " celebration cakes "], confirmedAt: "2026-11-20T10:00:00Z" });
  });

  it("keeps a short answer and adds what they sell to it; names the site by its domain when it has no name", () => {
    expect(profileFromAnswer({ description: "Cakes to order", offerings: ["wedding cakes"] }, "https://sugarloft.example/")!.description).toBe("Cakes to order. sugarloft.example offers wedding cakes.");
  });

  it("leaves a usable profile alone and builds nothing from nothing", () => {
    const usable = { description: "Sugarloft bakes wedding cakes to order for couples." };
    expect(profileFromAnswer(usable, "sugarloft.example")).toBe(usable);
    expect(profileFromAnswer({ name: "Sugarloft", description: "", offerings: [], audiences: ["couples"] }, "sugarloft.example")).toBeNull();
    expect(profileFromAnswer(null, "sugarloft.example")).toBeNull();
  });
});
