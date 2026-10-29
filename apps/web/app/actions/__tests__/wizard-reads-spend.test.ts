import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The setup wizard's paid reads: bought once, kept, counted
// ---------------------------------------------------------------------------
//
// The site read and the rival lookup fire when the wizard mounts, and nothing
// was saved before Finish, so every load of /onboarding bought both again: a
// crawl and a model call, then a seed proposal, results pages, a vetting call
// and a bulk-rank read. Before the trial nothing counted them. Pinned here: a
// reload is handed the read already bought; a press past the limit buys
// nothing and says why; the work runs under a spend scope for the site; and
// the rival lookup's rows are no longer handed to the person's own client,
// which provider_spend refuses.
//
// The door's counting runs for real here, in memory (no database in tests);
// the database's own count is checked in supabase/tests/116_spend_doors.rls.sql.

const canSpend = vi.fn();
vi.mock("@/lib/billing/spend-gate", () => ({ canSpend: (...a: unknown[]) => canSpend(...a) }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: async () => ({ accountId: "acc-1", role: "owner", user: { id: "u1", email: "owner@acme-agency.example" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/billing/default-spend", () => ({ spendClient: () => null, recordSpendByDefault: () => {} }));
vi.mock("@/lib/e2e/stubs", () => ({ e2eStubsEnabled: () => false, stubSuggestCompetitors: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { id: "ws-1", domain: "acme-agency.example", name: "Acme", business_profile: null }, error: null }) }) }),
    }),
  }),
}));

const viewing = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/lib/auth/impersonation", () => ({ refusedWhileViewingAs: async (what: string) => (viewing.value ? `${what} ${viewing.value}` : null) }));

const { currentSpendScope } = await import("@/lib/billing/spend-scope");

const PROFILE = { name: "Acme", description: "An agency that builds websites for clinics.", offerings: ["clinic websites"], audiences: ["clinic owners"], competitors: [], language: "English", country: "Global" };

const infer = vi.fn();
const inferScopes: Array<string | null> = [];
vi.mock("@/lib/onboarding/observed-facts", () => ({
  inferVerifiedBusinessProfile: async (domain: string) => {
    inferScopes.push(currentSpendScope()?.workspaceId ?? null);
    return infer(domain);
  },
}));

const findRivals = vi.fn();
const rivalCalls: Array<{ options: Record<string, unknown>; scope: string | null }> = [];
vi.mock("@/lib/onboarding/competitor-suggestions", () => ({
  classifyRivalSize: () => "similar",
  suggestCompetitors: async (options: Record<string, unknown>) => {
    rivalCalls.push({ options, scope: currentSpendScope()?.workspaceId ?? null });
    return findRivals(options);
  },
}));

const resolveDomains = vi.fn();
vi.mock("@/lib/onboarding/competitor-domains", () => ({
  looksLikeDomain: (s: string) => /\./.test(s),
  resolveCompetitorDomains: (...a: unknown[]) => resolveDomains(...a),
}));
vi.mock("@/lib/seo/domain-metrics", () => ({ fetchBulkAuthority: async () => new Map([["rival.example", 30]]) }));

const { proposeProfile, suggestCompetitors, resolveCompetitor } = await import("../onboarding-wizard");
const { resetDoorMemory, DOOR_LIMITS } = await import("@/lib/billing/spend-doors");

beforeEach(() => {
  resetDoorMemory();
  viewing.value = null;
  inferScopes.length = 0;
  rivalCalls.length = 0;
  canSpend.mockReset().mockResolvedValue({ allowed: true, reason: "free-allowance", message: null, quota: { reason: "no-plan", trialEligible: true } });
  infer.mockReset().mockResolvedValue({ profile: { ...PROFILE }, reason: "ok", source: "html" });
  findRivals.mockReset().mockResolvedValue({ own: 12, suggestions: [{ domain: "rival.example", size: "similar" }], searchRivals: ["rival.example"] });
  resolveDomains.mockReset().mockResolvedValue({ domains: ["rival.example"] });
});

describe("proposeProfile", () => {
  it("hands a reload the read it already bought", async () => {
    const first = await proposeProfile("ws-1");
    const second = await proposeProfile("ws-1");
    expect(infer).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.profile?.name).toBe("Acme");
  });

  it("runs the read under a spend scope for the site", async () => {
    await proposeProfile("ws-1");
    expect(inferScopes).toEqual(["ws-1"]);
  });

  it("keeps a failed read too, so a reload spends nothing", async () => {
    infer.mockResolvedValue({ profile: null, reason: "unreadable", source: "none", htmlLang: "it" });
    const first = await proposeProfile("ws-1");
    for (let i = 0; i < 5; i++) expect(await proposeProfile("ws-1")).toEqual(first);
    expect(infer).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ profile: null, reason: "unreadable", localeGuess: expect.objectContaining({ language: "Italian" }) });
  });

  it("joins a read already running instead of buying a second", async () => {
    let finish!: (v: unknown) => void;
    infer.mockReturnValue(new Promise((r) => (finish = r)));
    const both = Promise.all([proposeProfile("ws-1"), proposeProfile("ws-1")]);
    await new Promise((r) => setTimeout(r, 0));
    finish({ profile: { ...PROFILE }, reason: "ok", source: "html" });
    const [a, b] = await both;
    expect(infer).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it("Try again reads a kept failure again, until the limit, and the refusal blames nobody", async () => {
    infer.mockResolvedValue({ profile: null, reason: "unreadable", source: "none" });
    const perSite = DOOR_LIMITS["wizard-site-read"][0].limit;
    await proposeProfile("ws-1");
    for (let i = 1; i < perSite; i++) expect((await proposeProfile("ws-1", { again: true })).reason).toBe("unreadable");
    expect(infer).toHaveBeenCalledTimes(perSite);
    const refused = await proposeProfile("ws-1", { again: true });
    expect(refused).toMatchObject({ profile: null, reason: "limited", message: expect.stringContaining("could not get in") });
    expect(refused.message).not.toMatch(/as many times|allows/);
    expect(refused).toHaveProperty("localeGuess");
    expect(infer).toHaveBeenCalledTimes(perSite);
  });

  it("Try again after a read that worked hands back the read", async () => {
    await proposeProfile("ws-1");
    expect((await proposeProfile("ws-1", { again: true })).profile?.name).toBe("Acme");
    expect(infer).toHaveBeenCalledTimes(1);
  });

  it("says the gate's own sentence when the account cannot spend, and reads nothing", async () => {
    canSpend.mockResolvedValue({ allowed: false, reason: "paused", message: "Paused until 3 November.", quota: {} });
    expect(await proposeProfile("ws-1")).toMatchObject({ reason: "needs_plan", message: "Paused until 3 November." });
    expect(infer).not.toHaveBeenCalled();
  });

  it("does not count a self-hosted install", async () => {
    canSpend.mockResolvedValue({ allowed: true, reason: "self-host", message: null, quota: { reason: "self-host" } });
    infer.mockResolvedValue({ profile: null, reason: "unreadable", source: "none" });
    for (let i = 0; i < 6; i++) await proposeProfile("ws-1", { again: true });
    expect(infer).toHaveBeenCalledTimes(6);
  });
});

describe("suggestCompetitors", () => {
  it("hands a reload the rivals already looked up for the same profile", async () => {
    const first = await suggestCompetitors("ws-1", { ...PROFILE });
    // The same profile, keys in another order, with the confirmation stamp a
    // confirmed profile would carry: the same question.
    const { name, ...rest } = PROFILE;
    const second = await suggestCompetitors("ws-1", { ...rest, name, confirmedAt: "2026-10-16T08:00:00Z" } as typeof PROFILE);
    expect(findRivals).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("looks again for a different profile, under a scope for the site, with no sink on the person's client", async () => {
    await suggestCompetitors("ws-1", { ...PROFILE });
    await suggestCompetitors("ws-1", { ...PROFILE, offerings: ["dental websites"] });
    expect(findRivals).toHaveBeenCalledTimes(2);
    for (const call of rivalCalls) {
      expect(call.scope).toBe("ws-1");
      expect(call.options.spend).toBeUndefined();
    }
  });

  it("past the limit, buys nothing and reads as a lookup that could not look", async () => {
    const perSite = DOOR_LIMITS["wizard-rivals"][0].limit;
    for (let i = 0; i < perSite; i++) await suggestCompetitors("ws-1", { ...PROFILE, offerings: [`thing ${i}`] });
    const refused = await suggestCompetitors("ws-1", { ...PROFILE, offerings: ["one more"] });
    expect(refused).toEqual({ own: null, suggestions: [], searchRivals: [], lookupFailed: true });
    expect(findRivals).toHaveBeenCalledTimes(perSite);
  });

  it("does not keep a lookup that could not look", async () => {
    findRivals.mockResolvedValue({ own: null, suggestions: [], searchRivals: [], lookupFailed: true });
    await suggestCompetitors("ws-1", { ...PROFILE });
    await suggestCompetitors("ws-1", { ...PROFILE });
    expect(findRivals).toHaveBeenCalledTimes(2);
  });
});

describe("resolveCompetitor", () => {
  it("resolves a typed rival once, and is counted", async () => {
    expect(await resolveCompetitor("ws-1", "Rival", 20)).toEqual({ domain: "rival.example", authority: 30, size: "similar" });
    await resolveCompetitor("ws-1", "rival", 20);
    expect(resolveDomains).toHaveBeenCalledTimes(1);
  });

  it("past the limit, takes a typed domain as typed and invents nothing", async () => {
    const perSite = DOOR_LIMITS["wizard-rival-resolve"][0].limit;
    for (let i = 0; i < perSite; i++) await resolveCompetitor("ws-1", `name ${i}`, null);
    resolveDomains.mockClear();
    expect(await resolveCompetitor("ws-1", "https://www.other.example/x", null)).toEqual({ domain: "other.example", authority: null, size: null });
    expect(await resolveCompetitor("ws-1", "just a name", null)).toBeNull();
    expect(resolveDomains).not.toHaveBeenCalled();
  });
});

describe("while an operator is viewing as the account", () => {
  it("hands back what is kept, and buys nothing new on their account", async () => {
    await proposeProfile("ws-1");
    await suggestCompetitors("ws-1", { ...PROFILE });
    viewing.value = "is not run while viewing as owner@acme-agency.example";
    expect((await proposeProfile("ws-1")).profile?.name).toBe("Acme");
    expect((await suggestCompetitors("ws-1", { ...PROFILE })).suggestions).toHaveLength(1);
    expect(infer).toHaveBeenCalledTimes(1);
    expect(findRivals).toHaveBeenCalledTimes(1);

    resetDoorMemory();
    expect(await proposeProfile("ws-1")).toMatchObject({ profile: null, reason: "limited", message: expect.stringContaining("viewing as") });
    expect(await suggestCompetitors("ws-1", { ...PROFILE })).toMatchObject({ suggestions: [], lookupFailed: true });
    expect(await resolveCompetitor("ws-1", "Rival", 20)).toBeNull();
    expect(infer).toHaveBeenCalledTimes(1);
    expect(findRivals).toHaveBeenCalledTimes(1);
    expect(resolveDomains).not.toHaveBeenCalled();
    expect(canSpend).toHaveBeenCalledTimes(2);
  });
});
