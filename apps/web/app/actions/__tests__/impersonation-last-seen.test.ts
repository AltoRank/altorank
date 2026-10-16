import { beforeEach, describe, expect, it, vi } from "vitest";

// "View as" logs every view before it signs in as the customer, and the sign-in
// stamps the customer's last sign-in. The log row keeps the customer's own
// one, from before, so the Users page can show it (lib/auth/last-seen.ts);
// without migration 116 the row is written without it, and the view still
// opens.

const TARGET = "22222222-2222-4222-8222-222222222222";
const inserts: Array<Record<string, unknown>> = [];
let refuseColumn = false;

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));
vi.mock("@/lib/auth/operators", () => ({ isAdminEmail: () => true }));
vi.mock("@/lib/auth/impersonation-stash", () => ({
  decodeStash: () => null,
  encodeStash: () => "stash",
  sessionIdOf: () => "session-1",
  IMPERSONATION_COOKIE: "imp",
  IMPERSONATION_MAX_AGE_S: 3600,
}));

const session = { access_token: "a.b.c", refresh_token: "r" };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "op-1", email: "operator@altorank.example" } } }),
      getSession: async () => ({ data: { session } }),
      verifyOtp: async () => ({ data: { session }, error: null }),
      setSession: vi.fn(),
    },
  }),
  createServiceClient: () => ({
    auth: {
      admin: {
        getUserById: async () => ({
          data: { user: { id: TARGET, email: "owner@acme-agency.example", email_confirmed_at: "2026-09-01T00:00:00Z", last_sign_in_at: "2026-10-01T08:00:00.000Z" } },
          error: null,
        }),
        generateLink: async () => ({ data: { properties: { hashed_token: "h" } }, error: null }),
        signOut: vi.fn(async () => ({})),
      },
    },
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        const failed = refuseColumn && "target_last_sign_in_at" in row;
        return {
          select: () => ({
            single: async () =>
              failed
                ? { data: null, error: { message: "Could not find the 'target_last_sign_in_at' column of 'admin_impersonations' in the schema cache" } }
                : { data: { id: "log-1" }, error: null },
          }),
        };
      },
      update: () => ({ eq: async () => ({}) }),
    }),
  }),
}));

const { startImpersonation } = await import("../impersonation");

const start = async () => {
  const form = new FormData();
  form.set("userId", TARGET);
  return startImpersonation(null, form).catch((e: { to?: string }) => ({ redirectedTo: e.to }));
};

beforeEach(() => {
  inserts.length = 0;
  refuseColumn = false;
});

describe("startImpersonation", () => {
  it("keeps the customer's own last sign-in on the log row", async () => {
    expect(await start()).toEqual({ redirectedTo: "/dashboard" });
    expect(inserts).toEqual([expect.objectContaining({ target_user_id: TARGET, target_last_sign_in_at: "2026-10-01T08:00:00.000Z" })]);
  });

  it("still logs and opens the view on a database without the column", async () => {
    refuseColumn = true;
    expect(await start()).toEqual({ redirectedTo: "/dashboard" });
    expect(inserts).toHaveLength(2);
    expect(inserts[1]).not.toHaveProperty("target_last_sign_in_at");
    expect(inserts[1]).toMatchObject({ target_user_id: TARGET });
  });
});
