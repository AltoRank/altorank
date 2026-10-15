import { describe, expect, it, vi } from "vitest";

// A reviewer's edited hunk is stored rebuilt by the allowlist sanitiser, so
// what the next member opens on the review page is never raw markup.

const updated = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      update: (row: unknown) => {
        updated(row);
        const chain = {
          eq: () => chain,
          select: () => chain,
          maybeSingle: async () => ({ data: { id: "e1" }, error: null }),
        };
        return chain;
      },
    }),
  }),
}));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: async () => ({ accountId: "account-1", role: "editor", user: { id: "u1", email: "a@b.co" } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { saveExecutionDecisions } = await import("../refresh");

describe("saveExecutionDecisions", () => {
  it("stores edited hunks through the allowlist sanitiser and keeps the decisions", async () => {
    await saveExecutionDecisions("e1", {
      decisions: { h1: "accepted" },
      edited: { h2: '<p>mine<img/src=x/onerror=alert(1)></p><script>alert(1)</script>', h3: "" },
      fields: { title: "accepted" },
    });
    expect(updated).toHaveBeenCalledWith({
      decisions: {
        decisions: { h1: "accepted" },
        edited: { h2: '<p>mine<img src="x/onerror=alert(1)" /></p>', h3: "" },
        fields: { title: "accepted" },
      },
    });
  });
});
