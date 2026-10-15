import { describe, it, expect, vi, beforeEach } from "vitest";

// "Cancel checkout and return" on /checkout/cancelled: the one control meant
// to clear an open checkout. It threw "still opening" for ever on a
// reservation whose Stripe create had failed, and it always went back to the
// trial screen, even from a Billing purchase.

let attempt: Record<string, unknown> | null = null;
const deleted: string[] = [];
const { retrieve, expire, redirect } = vi.hoisted(() => ({
  retrieve: vi.fn(),
  expire: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: async () => ({ accountId: "account-1", role: "owner", user: { id: "u1" } }) }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ checkout: { sessions: { retrieve, expire } } }) }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: attempt, error: null }) }) }),
      delete: () => {
        const q = { eq: (c: string, v: string) => (c === "id" && deleted.push(v), q), then: (r: (v: unknown) => unknown) => r({ error: null }) };
        return q;
      },
    }),
  }),
}));

const hourFromNow = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000 + 3_600_000).toISOString();
function form(next?: string) {
  const f = new FormData();
  if (next !== undefined) f.set("next", next);
  return f;
}

beforeEach(() => {
  attempt = null;
  deleted.length = 0;
  retrieve.mockReset();
  expire.mockReset();
});

describe("cancelPendingCheckout", () => {
  it("clears a reservation whose session was never saved, once it is old enough to be dead", async () => {
    attempt = { id: "a1", stripe_session_id: null, expires_at: hourFromNow(30) };
    const { cancelPendingCheckout } = await import("../cancel-checkout");
    await expect(cancelPendingCheckout(form())).rejects.toThrow("REDIRECT /onboarding?status=cancelled");
    expect(deleted).toEqual(["a1"]);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("still waits on a reservation that is opening right now", async () => {
    attempt = { id: "a1", stripe_session_id: null, expires_at: hourFromNow(0) };
    const { cancelPendingCheckout } = await import("../cancel-checkout");
    await expect(cancelPendingCheckout(form())).rejects.toThrow("still opening");
    expect(deleted).toEqual([]);
  });

  it("closes an open session and returns to Billing when that is where it came from", async () => {
    attempt = { id: "a1", stripe_session_id: "cs_1", expires_at: hourFromNow(5) };
    retrieve.mockResolvedValue({ id: "cs_1", client_reference_id: "account-1", status: "open" });
    const { cancelPendingCheckout } = await import("../cancel-checkout");
    await expect(cancelPendingCheckout(form("/settings/billing"))).rejects.toThrow("REDIRECT /settings/billing");
    expect(expire).toHaveBeenCalledWith("cs_1");
    expect(deleted).toEqual(["a1"]);
  });

  it("never returns to somewhere off the site", async () => {
    const { cancelPendingCheckout } = await import("../cancel-checkout");
    await expect(cancelPendingCheckout(form("//evil.example"))).rejects.toThrow("REDIRECT /dashboard");
  });
});

describe("cancelled-checkout destinations", () => {
  it("defaults to the trial screen, and carries a purchase's destination back to Billing", async () => {
    const { cancelledCheckoutReturn, billingReturnPath } = await import("@/lib/billing/checkout-return");
    expect(cancelledCheckoutReturn(undefined)).toBe("/onboarding?status=cancelled");
    expect(cancelledCheckoutReturn("/settings/billing")).toBe("/settings/billing");
    expect(billingReturnPath("/dashboard")).toBe("/settings/billing");
    expect(billingReturnPath("/connect/google")).toBe("/settings/billing?return=%2Fconnect%2Fgoogle");
  });
});
