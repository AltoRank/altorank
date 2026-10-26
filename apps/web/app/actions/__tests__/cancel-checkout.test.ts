import { describe, it, expect, vi, beforeEach } from "vitest";

// The one control on /checkout/cancelled that clears an open checkout ("Back
// to my article" for a trial, "Cancel checkout and return" on Billing). It
// threw "still opening" for ever on a reservation whose Stripe create had
// failed, and it always went back to the trial screen, even from a Billing
// purchase. Its refusals now come back as sentences: a thrown one reaches
// production as an opaque digest.

let attempt: Record<string, unknown> | null = null;
let readError: { message: string } | null = null;
let deleteError: { message: string } | null = null;
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
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: readError ? null : attempt, error: readError }) }) }),
      delete: () => {
        const q = { eq: (c: string, v: string) => (c === "id" && !deleteError && deleted.push(v), q), then: (r: (v: unknown) => unknown) => r({ error: deleteError }) };
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
  readError = null;
  deleteError = null;
  deleted.length = 0;
  retrieve.mockReset();
  expire.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("cancelPendingCheckout", () => {
  it("clears a reservation whose session was never saved, once it is old enough to be dead", async () => {
    attempt = { id: "a1", stripe_session_id: null, expires_at: hourFromNow(30) };
    const { cancelPendingCheckout } = await import("../cancel-checkout");
    await expect(cancelPendingCheckout(null, form())).rejects.toThrow("REDIRECT /onboarding?status=cancelled");
    expect(deleted).toEqual(["a1"]);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("says a reservation that is opening right now is still opening, and leaves it", async () => {
    attempt = { id: "a1", stripe_session_id: null, expires_at: hourFromNow(0) };
    const { cancelPendingCheckout } = await import("../cancel-checkout");
    const result = await cancelPendingCheckout(null, form());
    expect(result?.error).toMatch(/still opening/);
    expect(result?.error).toMatch(/Nothing was charged/);
    expect(deleted).toEqual([]);
  });

  it("closes an open session and returns to Billing when that is where it came from", async () => {
    attempt = { id: "a1", stripe_session_id: "cs_1", expires_at: hourFromNow(5) };
    retrieve.mockResolvedValue({ id: "cs_1", client_reference_id: "account-1", status: "open" });
    const { cancelPendingCheckout } = await import("../cancel-checkout");
    await expect(cancelPendingCheckout(null, form("/settings/billing"))).rejects.toThrow("REDIRECT /settings/billing");
    expect(expire).toHaveBeenCalledWith("cs_1");
    expect(deleted).toEqual(["a1"]);
  });

  it("closes an open session and returns to the trial screen with no notice when asked to", async () => {
    attempt = { id: "a1", stripe_session_id: "cs_1", expires_at: hourFromNow(5) };
    retrieve.mockResolvedValue({ id: "cs_1", client_reference_id: "account-1", status: "open" });
    const { cancelPendingCheckout } = await import("../cancel-checkout");
    await expect(cancelPendingCheckout(null, form("/onboarding"))).rejects.toThrow("REDIRECT /onboarding");
    expect(expire).toHaveBeenCalledWith("cs_1");
  });

  it("goes straight back when there is no open checkout at all", async () => {
    const { cancelPendingCheckout } = await import("../cancel-checkout");
    await expect(cancelPendingCheckout(null, form("/onboarding?status=cancelled"))).rejects.toThrow("REDIRECT /onboarding?status=cancelled");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("never returns to somewhere off the site", async () => {
    const { cancelPendingCheckout } = await import("../cancel-checkout");
    await expect(cancelPendingCheckout(null, form("//evil.example"))).rejects.toThrow("REDIRECT /dashboard");
  });

  it("says why, in a sentence, when the checkout could not be read, reached at Stripe, closed or cleared", async () => {
    const { cancelPendingCheckout } = await import("../cancel-checkout");

    readError = { message: "connection reset" };
    expect((await cancelPendingCheckout(null, form()))?.error).toBe("Your open checkout could not be read. Nothing was charged. Try again in a moment.");
    readError = null;

    attempt = { id: "a1", stripe_session_id: "cs_1", expires_at: hourFromNow(5) };
    retrieve.mockRejectedValueOnce(new Error("Invalid API Key provided: sk_test_****"));
    const unreachable = (await cancelPendingCheckout(null, form()))?.error;
    expect(unreachable).toMatch(/^Checkout could not be closed\. Nothing has been charged/);
    expect(unreachable).not.toMatch(/API Key|sk_test/);

    retrieve.mockResolvedValue({ id: "cs_1", client_reference_id: "account-1", status: "open" });
    expire.mockRejectedValueOnce(new Error("Stripe is down"));
    expect((await cancelPendingCheckout(null, form()))?.error).toMatch(/^Checkout could not be closed\./);

    retrieve.mockResolvedValue({ id: "cs_1", client_reference_id: "account-2", status: "open" });
    expect((await cancelPendingCheckout(null, form()))?.error).toMatch(/belongs to another account/);
    expect(expire).toHaveBeenCalledTimes(1);

    retrieve.mockResolvedValue({ id: "cs_1", client_reference_id: "account-1", status: "expired" });
    deleteError = { message: "timeout" };
    expect((await cancelPendingCheckout(null, form()))?.error).toMatch(/could not be cleared here/);
    expect(deleted).toEqual([]);
  });

  it("goes to the completion page for a session that was paid after all", async () => {
    attempt = { id: "a1", stripe_session_id: "cs_1", expires_at: hourFromNow(5) };
    retrieve.mockResolvedValue({ id: "cs_1", client_reference_id: "account-1", status: "complete" });
    const { cancelPendingCheckout } = await import("../cancel-checkout");
    await expect(cancelPendingCheckout(null, form())).rejects.toThrow("REDIRECT /checkout/complete?session_id=cs_1");
    expect(deleted).toEqual([]);
  });
});

describe("cancelled-checkout destinations", () => {
  it("defaults to the trial screen, and carries a purchase's destination back to Billing", async () => {
    const { cancelledCheckoutReturn, billingReturnPath } = await import("@/lib/billing/checkout-return");
    expect(cancelledCheckoutReturn(undefined)).toBe("/onboarding?status=cancelled");
    expect(cancelledCheckoutReturn("/settings/billing")).toBe("/settings/billing");
    expect(cancelledCheckoutReturn("/onboarding")).toBe("/onboarding");
    expect(billingReturnPath("/dashboard")).toBe("/settings/billing");
    expect(billingReturnPath("/connect/google")).toBe("/settings/billing?return=%2Fconnect%2Fgoogle");
  });
});
