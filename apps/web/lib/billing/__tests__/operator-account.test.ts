import { describe, it, expect, beforeEach } from "vitest";
import { accountHasOperator, clearOperatorAccountCache } from "../operator-account";

/** A service client stand-in: members by account, emails by user id. */
function client(members: string[], emails: Record<string, string>, opts: { throwOnAdmin?: boolean } = {}) {
  let getUserByIdCalls = 0;
  const c = {
    from: () => ({ select: () => ({ eq: async () => ({ data: members.map((user_id) => ({ user_id })) }) }) }),
    auth: {
      admin: {
        getUserById: async (id: string) => {
          getUserByIdCalls += 1;
          if (opts.throwOnAdmin) throw new Error("not authorised");
          return { data: { user: { email: emails[id] } } };
        },
      },
    },
  };
  return { c: c as never, calls: () => getUserByIdCalls };
}

beforeEach(() => clearOperatorAccountCache());

describe("accountHasOperator", () => {
  it("recognises an account whose member is an operator", async () => {
    const { c } = client(["u1"], { u1: "helloaltorank@gmail.com" });
    expect(await accountHasOperator(c, "a1")).toBe(true);
  });

  it("does not recognise a customer account", async () => {
    const { c } = client(["u1", "u2"], { u1: "someone@client.com", u2: "other@client.com" });
    expect(await accountHasOperator(c, "a1")).toBe(false);
  });

  it("stops at the first operator rather than resolving every member", async () => {
    const { c, calls } = client(["u1", "u2", "u3"], {
      u1: "helloaltorank@gmail.com", u2: "a@b.c", u3: "d@e.f",
    });
    await accountHasOperator(c, "a1");
    expect(calls()).toBe(1);
  });

  it("answers false when the admin API is unavailable", async () => {
    // A cookie-bound client cannot call auth.admin. Failing closed means an
    // account is metered unless we can prove it is ours - never the reverse.
    const { c } = client(["u1"], { u1: "helloaltorank@gmail.com" }, { throwOnAdmin: true });
    expect(await accountHasOperator(c, "a1")).toBe(false);
  });

  it("caches per account so a cron does not re-resolve every workspace", async () => {
    const { c, calls } = client(["u1"], { u1: "helloaltorank@gmail.com" });
    await accountHasOperator(c, "a1");
    await accountHasOperator(c, "a1");
    await accountHasOperator(c, "a1");
    expect(calls()).toBe(1);
  });

  it("treats an account with no members as not ours", async () => {
    const { c } = client([], {});
    expect(await accountHasOperator(c, "a1")).toBe(false);
  });
});
