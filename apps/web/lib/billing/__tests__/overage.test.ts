import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Deleting a draft gives its slot back, so the next draft past the volume is
// billed again. A billed draft that was then deleted kept its charge too: two
// charges for one surviving article. The pending charge now goes with it.

const { create, list, del } = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stripe")>()),
  billingEnabled: true,
  getStripe: () => ({ invoiceItems: { create, list, del } }),
}));

import { recordOverageArticle, removePendingOverage } from "../overage";

const db = {
  from: () => {
    const q = { select: () => q, eq: () => q, single: async () => ({ data: { stripe_customer_id: "cus_1" } }), maybeSingle: async () => ({ data: { stripe_customer_id: "cus_1" } }) };
    return q;
  },
} as unknown as SupabaseClient;
const quota = { limit: 100, used: 100, remaining: 0, reason: "plan", plan: "starter" } as never;

beforeEach(() => {
  create.mockReset().mockResolvedValue({ id: "ii_1" });
  list.mockReset();
  del.mockReset().mockResolvedValue({ deleted: true });
});

describe("recordOverageArticle", () => {
  it("writes the article's id on the charge", async () => {
    await recordOverageArticle(db, "acc-1", quota, "art-1");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_1", amount: 60, metadata: { account_id: "acc-1", article_id: "art-1" } }));
  });
});

describe("removePendingOverage", () => {
  it("removes only the deleted article's pending charge", async () => {
    list.mockResolvedValue({ data: [
      { id: "ii_mine", metadata: { article_id: "art-1" } },
      { id: "ii_other", metadata: { article_id: "art-2" } },
      { id: "ii_plain", metadata: {} },
    ] });
    expect(await removePendingOverage(db, "acc-1", "art-1")).toBe(1);
    expect(list).toHaveBeenCalledWith({ customer: "cus_1", pending: true, limit: 100 });
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("ii_mine");
  });

  it("never fails the delete over Stripe", async () => {
    list.mockRejectedValue(new Error("Stripe is down"));
    expect(await removePendingOverage(db, "acc-1", "art-1")).toBe(0);
  });
});
