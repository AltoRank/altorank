import { describe, it, expect, beforeEach } from "vitest";
import { accountHasOperator, clearOperatorAccountCache } from "../operator-account";

const OPERATOR = "helloaltorank@gmail.com";

/**
 * A service client stand-in: the account's recorded creator (migration 101)
 * and every member, with emails by user id. The members are there to show
 * they are NOT what the answer is read from.
 */
function client(
  account: { created_by: string | null; members?: string[] },
  emails: Record<string, string>,
  opts: { throwOnAdmin?: boolean; errorOnAdmin?: boolean; errorOnAccount?: boolean } = {},
) {
  let getUserByIdCalls = 0;
  const c = {
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          const rows = table === "account_members" ? (account.members ?? []).map((user_id) => ({ user_id })) : [];
          return {
            maybeSingle: async () =>
              opts.errorOnAccount
                ? { data: null, error: { message: 'column accounts.created_by does not exist' } }
                : { data: table === "accounts" ? { created_by: account.created_by } : null, error: null },
            then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
          };
        },
      }),
    }),
    auth: {
      admin: {
        getUserById: async (id: string) => {
          getUserByIdCalls += 1;
          if (opts.throwOnAdmin) throw new Error("not authorised");
          // What supabase-js does on a cookie-bound client: no throw, an error.
          if (opts.errorOnAdmin) return { data: { user: null }, error: { message: "User not allowed" } };
          return { data: { user: { email: emails[id] } }, error: null };
        },
      },
    },
  };
  return { c: c as never, calls: () => getUserByIdCalls };
}

beforeEach(() => clearOperatorAccountCache());

describe("accountHasOperator", () => {
  it("recognises an account an operator created", async () => {
    const { c } = client({ created_by: "u1" }, { u1: OPERATOR });
    expect(await accountHasOperator(c, "a1")).toBe(true);
  });

  it("does not recognise a customer account", async () => {
    const { c } = client({ created_by: "u1", members: ["u1", "u2"] }, { u1: "someone@client.example", u2: "other@client.example" });
    expect(await accountHasOperator(c, "a1")).toBe(false);
  });

  it("is not made ours by an operator who is only a member", async () => {
    // Round-4 review: an owner could insert an operator's user id into their
    // own account, and an operator who accepted an invitation to help a
    // customer made the customer's account "ours" - unmetered crons, no trial
    // hold, no body lock. Membership is the owner's to give; creation is not.
    const { c, calls } = client(
      { created_by: "customer", members: ["customer", "op"] },
      { customer: "owner@client.example", op: OPERATOR },
    );
    expect(await accountHasOperator(c, "a1")).toBe(false);
    // Only the creator was looked up.
    expect(calls()).toBe(1);
  });

  it("treats an account with no creator on record as not ours", async () => {
    const { c, calls } = client({ created_by: null, members: ["op"] }, { op: OPERATOR });
    expect(await accountHasOperator(c, "a1")).toBe(false);
    expect(calls()).toBe(0);
  });

  it("answers false when the admin API is unavailable", async () => {
    // A cookie-bound client cannot call auth.admin. Failing closed means an
    // account is metered unless we can prove it is ours - never the reverse.
    const { c } = client({ created_by: "u1" }, { u1: OPERATOR }, { throwOnAdmin: true });
    expect(await accountHasOperator(c, "a1")).toBe(false);
  });

  it("caches per account so a cron does not re-resolve every workspace", async () => {
    const { c, calls } = client({ created_by: "u1" }, { u1: OPERATOR });
    await accountHasOperator(c, "a1");
    await accountHasOperator(c, "a1");
    await accountHasOperator(c, "a1");
    expect(calls()).toBe(1);
  });

  it("does not remember an answer from a client that could not look", async () => {
    // Round-4 review: one Publish click on a cookie client cached "not an
    // operator" for the process, and every service-role cron after it
    // metered our own account.
    const cookie = client({ created_by: "u1" }, { u1: OPERATOR }, { errorOnAdmin: true });
    expect(await accountHasOperator(cookie.c, "a1")).toBe(false);
    const service = client({ created_by: "u1" }, { u1: OPERATOR });
    expect(await accountHasOperator(service.c, "a1")).toBe(true);
  });

  it("does not remember a throw either", async () => {
    const cookie = client({ created_by: "u1" }, { u1: OPERATOR }, { throwOnAdmin: true });
    expect(await accountHasOperator(cookie.c, "a1")).toBe(false);
    const service = client({ created_by: "u1" }, { u1: OPERATOR });
    expect(await accountHasOperator(service.c, "a1")).toBe(true);
  });

  it("does not remember a creator read that failed (before migration 101)", async () => {
    const before = client({ created_by: "u1" }, { u1: OPERATOR }, { errorOnAccount: true });
    expect(await accountHasOperator(before.c, "a1")).toBe(false);
    const after = client({ created_by: "u1" }, { u1: OPERATOR });
    expect(await accountHasOperator(after.c, "a1")).toBe(true);
  });
});
