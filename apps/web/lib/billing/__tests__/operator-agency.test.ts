import { describe, it, expect, beforeEach } from "vitest";
import { agencyHasOperator, clearOperatorAgencyCache } from "../operator-agency";

/** A service client stand-in: members by agency, emails by user id. */
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

beforeEach(() => clearOperatorAgencyCache());

describe("agencyHasOperator", () => {
  it("recognises an agency whose member is an operator", async () => {
    const { c } = client(["u1"], { u1: "helloaltorank@gmail.com" });
    expect(await agencyHasOperator(c, "a1")).toBe(true);
  });

  it("does not recognise a customer agency", async () => {
    const { c } = client(["u1", "u2"], { u1: "someone@client.com", u2: "other@client.com" });
    expect(await agencyHasOperator(c, "a1")).toBe(false);
  });

  it("stops at the first operator rather than resolving every member", async () => {
    const { c, calls } = client(["u1", "u2", "u3"], {
      u1: "helloaltorank@gmail.com", u2: "a@b.c", u3: "d@e.f",
    });
    await agencyHasOperator(c, "a1");
    expect(calls()).toBe(1);
  });

  it("answers false when the admin API is unavailable", async () => {
    // A cookie-bound client cannot call auth.admin. Failing closed means an
    // account is metered unless we can prove it is ours - never the reverse.
    const { c } = client(["u1"], { u1: "helloaltorank@gmail.com" }, { throwOnAdmin: true });
    expect(await agencyHasOperator(c, "a1")).toBe(false);
  });

  it("caches per agency so a cron does not re-resolve every workspace", async () => {
    const { c, calls } = client(["u1"], { u1: "helloaltorank@gmail.com" });
    await agencyHasOperator(c, "a1");
    await agencyHasOperator(c, "a1");
    await agencyHasOperator(c, "a1");
    expect(calls()).toBe(1);
  });

  it("treats an agency with no members as not ours", async () => {
    const { c } = client([], {});
    expect(await agencyHasOperator(c, "a1")).toBe(false);
  });
});
