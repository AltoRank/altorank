import { describe, it, expect, vi, beforeEach } from "vitest";

// Finishing the wizard is the opt-in to drafting, and it used to write
// `status: "on"` whatever the site's status was. The account pause on Billing
// pauses sites still in setup too, and the wizard opens for any site in scope,
// so finishing it started that one site drafting through the pause.

type Write = { values: Record<string, unknown>; filters: Array<[string, string, unknown]> };
const writes: Write[] = [];
let status = "paused";

function updateQuery(values: Record<string, unknown>) {
  const w: Write = { values, filters: [] };
  writes.push(w);
  const q = {
    eq: (c: string, v: unknown) => (w.filters.push(["eq", c, v]), q),
    neq: (c: string, v: unknown) => (w.filters.push(["neq", c, v]), q),
    then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
  };
  return q;
}

/** Whether a write's filters match the one row, as Postgres would. */
const applies = (w: Write) =>
  w.filters.every(([op, c, v]) => (c !== "status" ? true : op === "eq" ? status === v : status !== v));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: async () => ({ accountId: "acc-1", role: "owner", user: { id: "u1" } }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { id: "ws-1", domain: "example.com" }, error: null }) }) }),
      update: updateQuery,
    }),
  }),
}));

beforeEach(() => {
  writes.length = 0;
});

describe("completeWizard", () => {
  it("does not lift a pause: a paused site takes the opt-in and stays paused", async () => {
    status = "paused";
    const { completeWizard } = await import("../onboarding-wizard");
    await completeWizard("ws-1");
    const landed = writes.filter(applies);
    expect(landed.some((w) => "status" in w.values)).toBe(false);
    expect(landed).toContainEqual(expect.objectContaining({ values: expect.objectContaining({ auto_generate: true }) }));
  });

  it("turns a site in setup on", async () => {
    status = "setup";
    const { completeWizard } = await import("../onboarding-wizard");
    await completeWizard("ws-1");
    const landed = writes.filter(applies);
    expect(landed).toContainEqual(expect.objectContaining({ values: expect.objectContaining({ status: "on", auto_generate: true }) }));
  });
});
