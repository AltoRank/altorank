import { describe, it, expect } from "vitest";
import { agencyRecipients } from "../agency-recipients";

/** A service-role client stand-in: members by agency, emails by user id. */
function client(members: string[], emails: Record<string, string | undefined>, opts: { throwOnAdmin?: boolean } = {}) {
  return {
    from: () => ({ select: () => ({ eq: async () => ({ data: members.map((user_id) => ({ user_id })) }) }) }),
    auth: {
      admin: {
        getUserById: async (id: string) => {
          if (opts.throwOnAdmin) throw new Error("not authorised");
          return { data: { user: { email: emails[id] } } };
        },
      },
    },
  } as never;
}

describe("agencyRecipients", () => {
  it("resolves every member's address", async () => {
    const c = client(["u1", "u2"], { u1: "a@x.co", u2: "b@x.co" });
    expect((await agencyRecipients(c, "ag1")).sort()).toEqual(["a@x.co", "b@x.co"]);
  });

  /** One person, two memberships, one email - a duplicate reads as a bug. */
  it("deduplicates, case-insensitively", async () => {
    const c = client(["u1", "u2"], { u1: "Same@X.co", u2: "same@x.co" });
    expect(await agencyRecipients(c, "ag1")).toEqual(["same@x.co"]);
  });

  it("skips a member with no address rather than sending to undefined", async () => {
    const c = client(["u1", "u2"], { u1: "a@x.co", u2: undefined });
    expect(await agencyRecipients(c, "ag1")).toEqual(["a@x.co"]);
  });

  /**
   * auth.admin throws on a cookie-bound client. Returning nobody is the right
   * direction: a notification is not worth failing the work it announces.
   */
  it("returns nobody when the client cannot read auth", async () => {
    const c = client(["u1"], { u1: "a@x.co" }, { throwOnAdmin: true });
    expect(await agencyRecipients(c, "ag1")).toEqual([]);
  });

  it("returns nobody for an agency with no members", async () => {
    expect(await agencyRecipients(client([], {}), "ag1")).toEqual([]);
  });
});
