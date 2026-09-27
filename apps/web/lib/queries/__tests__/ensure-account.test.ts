// ensureAccount makes an account for a person with no membership left. A
// person removed from an account they created must not get a fresh pre-trial
// allowance with it (round-5 review): the free-draft count they used comes
// with them.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state: {
  memberships: Row[];
  accounts: Row[];
  inserted: { table: string; row: Row }[];
  accountsReadError: string | null;
} = { memberships: [], accounts: [], inserted: [], accountsReadError: null };

function sessionClient() {
  return {
    from: (table: string) => {
      if (table !== "account_members") throw new Error(`unexpected session read of ${table}`);
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        single: async () =>
          state.memberships.length
            ? { data: state.memberships[0], error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } },
      };
      return chain;
    },
  };
}

function serviceClient() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: async (column: string, value: unknown) => {
          if (table !== "accounts" || column !== "created_by") throw new Error(`unexpected read ${table}.${column}`);
          if (state.accountsReadError) return { data: null, error: { message: state.accountsReadError } };
          return { data: state.accounts.filter((a) => a.created_by === value), error: null };
        },
      }),
      insert: (row: Row) => {
        state.inserted.push({ table, row });
        return {
          select: () => ({ single: async () => ({ data: { id: "acct-new" }, error: null }) }),
          then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
        };
      },
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => sessionClient(),
  createServiceClient: () => serviceClient(),
}));
vi.mock("@/lib/workspace-scope", () => ({ getScope: async () => null }));

const USER = "user-1";

beforeEach(() => {
  state.memberships = [];
  state.accounts = [];
  state.inserted = [];
  state.accountsReadError = null;
});

describe("ensureAccount", () => {
  it("returns the existing membership and creates nothing", async () => {
    state.memberships = [{ account_id: "acct-1" }];
    const { ensureAccount } = await import("../account");
    expect(await ensureAccount(USER, {}, "person@acme-agency.example")).toBe("acct-1");
    expect(state.inserted).toHaveLength(0);
  });

  it("starts a person who never made an account at zero", async () => {
    const { ensureAccount } = await import("../account");
    expect(await ensureAccount(USER, {}, "person@acme-agency.example")).toBe("acct-new");
    const account = state.inserted.find((i) => i.table === "accounts")!.row;
    expect(account.free_drafts_used).toBe(0);
  });

  it("carries the pre-trial article a removed owner already used into the account made for them again", async () => {
    state.accounts = [
      { created_by: USER, free_drafts_used: 1 },
      { created_by: "someone-else", free_drafts_used: 7 },
    ];
    const { ensureAccount } = await import("../account");
    await ensureAccount(USER, {}, "person@acme-agency.example");
    const account = state.inserted.find((i) => i.table === "accounts")!.row;
    expect(account.free_drafts_used).toBe(1);
    const member = state.inserted.find((i) => i.table === "account_members")!.row;
    expect(member).toMatchObject({ account_id: "acct-new", user_id: USER, role: "owner" });
  });

  it("takes the most any of their accounts used", async () => {
    state.accounts = [
      { created_by: USER, free_drafts_used: 3 },
      { created_by: USER, free_drafts_used: null },
      { created_by: USER, free_drafts_used: 5 },
    ];
    const { ensureAccount } = await import("../account");
    await ensureAccount(USER, {}, "person@acme-agency.example");
    expect(state.inserted.find((i) => i.table === "accounts")!.row.free_drafts_used).toBe(5);
  });

  it("refuses to create an account when it cannot read what the person already used", async () => {
    state.accountsReadError = "boom";
    const { ensureAccount } = await import("../account");
    await expect(ensureAccount(USER, {}, "person@acme-agency.example")).rejects.toThrow(/accounts this person created/);
    expect(state.inserted).toHaveLength(0);
  });
});
