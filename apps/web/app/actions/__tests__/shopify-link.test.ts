import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  site: null as Record<string, unknown> | null,
  linkStore: vi.fn(),
  verifyLinkToken: vi.fn(),
  readLinkSource: vi.fn(),
  sourceRetirementBlocker: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({}),
  createClient: async () => {
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: m.site }) };
    return { from: () => chain };
  },
}));
vi.mock("@/lib/shopify/link", () => ({
  linkStore: m.linkStore,
  verifyLinkToken: m.verifyLinkToken,
  readLinkSource: m.readLinkSource,
  sourceRetirementBlocker: m.sourceRetirementBlocker,
}));

import { linkShopifyStore } from "../shopify-link";

beforeEach(() => {
  Object.values(m).forEach((f) => typeof f === "function" && "mockReset" in f && (f as ReturnType<typeof vi.fn>).mockReset());
  m.requireAuth.mockResolvedValue({ user: { id: "u-me", email: "me@x.com" }, accountId: "acc-me", role: "owner" });
  m.verifyLinkToken.mockReturnValue({ ok: true, payload: {} });
  m.readLinkSource.mockResolvedValue({ installationId: "inst-1", fromAccountId: "acc-store", domain: "fern.com" });
  m.sourceRetirementBlocker.mockResolvedValue(null);
  m.linkStore.mockResolvedValue({ ok: true, workspaceId: "ws-mine" });
  m.site = { id: "ws-mine", domain: "fern.com", account_id: "acc-me" };
});

describe("linkShopifyStore", () => {
  it("links the store to one of the person's own sites", async () => {
    expect(await linkShopifyStore("tok", "ws-mine")).toEqual({ ok: true, domain: "fern.com" });
    expect(m.linkStore).toHaveBeenCalledWith({}, expect.anything(), { accountId: "acc-me", workspaceId: "ws-mine" });
  });

  it("refuses a site that is not on the signed-in account", async () => {
    m.site = null;
    expect(await linkShopifyStore("tok", "ws-someone-else")).toEqual({ ok: false, error: "Choose one of your sites." });
    expect(m.linkStore).not.toHaveBeenCalled();
  });

  it("refuses an editor", async () => {
    m.requireAuth.mockResolvedValue({ user: { id: "u" }, accountId: "acc-me", role: "editor" });
    expect((await linkShopifyStore("tok", "ws-mine")).ok).toBe(false);
    expect(m.verifyLinkToken).not.toHaveBeenCalled();
  });

  it("refuses a bad token before reading anything", async () => {
    m.verifyLinkToken.mockReturnValue({ ok: false, reason: "The link has expired." });
    expect(await linkShopifyStore("tok", "ws-mine")).toEqual({ ok: false, error: "The link has expired." });
    expect(m.readLinkSource).not.toHaveBeenCalled();
  });

  it("refuses when the store's own account holds real work", async () => {
    m.sourceRetirementBlocker.mockResolvedValue("Email hello@altorank.co and we will merge the two accounts.");
    expect((await linkShopifyStore("tok", "ws-mine")).ok).toBe(false);
    expect(m.linkStore).not.toHaveBeenCalled();
  });
});
