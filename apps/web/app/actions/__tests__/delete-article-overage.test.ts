import { describe, it, expect, vi, beforeEach } from "vitest";

// deleteArticle takes back a pending overage charge, but only for a row the
// delete really removed: RLS can hide a row, and then nothing was deleted.

let removedRows: { id: string }[] = [];
const { removePendingOverage } = vi.hoisted(() => ({ removePendingOverage: vi.fn(async () => 1) }));
vi.mock("@/lib/billing/overage", () => ({ removePendingOverage }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: async () => ({ accountId: "acc-1", role: "editor", user: { id: "u1" } }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ delete: () => ({ eq: () => ({ select: async () => ({ data: removedRows, error: null }) }) }) }),
  }),
}));

beforeEach(() => {
  removedRows = [];
  removePendingOverage.mockClear();
});

describe("deleteArticle", () => {
  it("takes back the deleted draft's pending overage charge", async () => {
    removedRows = [{ id: "art-1" }];
    const { deleteArticle } = await import("../articles");
    await deleteArticle("art-1");
    expect(removePendingOverage).toHaveBeenCalledWith(expect.anything(), "acc-1", "art-1");
  });

  it("touches no charge when nothing was deleted", async () => {
    const { deleteArticle } = await import("../articles");
    await deleteArticle("art-1");
    expect(removePendingOverage).not.toHaveBeenCalled();
  });
});
