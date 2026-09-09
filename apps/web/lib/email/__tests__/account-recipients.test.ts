import { describe, it, expect } from "vitest";
import { accountRecipients, canSeeWorkspace } from "../account-recipients";

type Member = string | { user_id: string; workspace_ids: string[] | null };

/** A service-role client stand-in: members by account, emails by user id. */
function client(members: Member[], emails: Record<string, string | undefined>, opts: { throwOnAdmin?: boolean } = {}) {
  const rows = members.map((m) => (typeof m === "string" ? { user_id: m, workspace_ids: null } : m));
  return {
    from: () => ({ select: () => ({ eq: async () => ({ data: rows }) }) }),
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

describe("accountRecipients", () => {
  it("resolves every member's address", async () => {
    const c = client(["u1", "u2"], { u1: "a@x.co", u2: "b@x.co" });
    expect((await accountRecipients(c, "ag1", "ws1")).sort()).toEqual(["a@x.co", "b@x.co"]);
  });

  /** One person, two memberships, one email - a duplicate reads as a bug. */
  it("deduplicates, case-insensitively", async () => {
    const c = client(["u1", "u2"], { u1: "Same@X.co", u2: "same@x.co" });
    expect(await accountRecipients(c, "ag1", "ws1")).toEqual(["same@x.co"]);
  });

  it("skips a member with no address rather than sending to undefined", async () => {
    const c = client(["u1", "u2"], { u1: "a@x.co", u2: undefined });
    expect(await accountRecipients(c, "ag1", "ws1")).toEqual(["a@x.co"]);
  });

  /**
   * auth.admin throws on a cookie-bound client. Returning nobody is the right
   * direction: a notification is not worth failing the work it announces.
   */
  it("returns nobody when the client cannot read auth", async () => {
    const c = client(["u1"], { u1: "a@x.co" }, { throwOnAdmin: true });
    expect(await accountRecipients(c, "ag1", "ws1")).toEqual([]);
  });

  /**
   * The leak: an editor restricted to site A was told about site B's draft,
   * keyword, title and link included. `workspace_ids` is the same column RLS
   * reads for the pages; the mail follows the same rule.
   */
  it("skips members whose workspace_ids do not include the workspace", async () => {
    const c = client(
      [
        { user_id: "u1", workspace_ids: null },
        { user_id: "u2", workspace_ids: ["ws1", "ws9"] },
        { user_id: "u3", workspace_ids: ["ws2"] },
        { user_id: "u4", workspace_ids: [] },
      ],
      { u1: "all@x.co", u2: "ws1@x.co", u3: "ws2@x.co", u4: "none@x.co" },
    );
    expect((await accountRecipients(c, "ag1", "ws1")).sort()).toEqual(["all@x.co", "ws1@x.co"]);
    expect((await accountRecipients(c, "ag1", "ws2")).sort()).toEqual(["all@x.co", "ws2@x.co"]);
  });

  it("canSeeWorkspace mirrors the RLS predicate", () => {
    expect(canSeeWorkspace(null, "ws1")).toBe(true);
    expect(canSeeWorkspace(undefined, "ws1")).toBe(true);
    expect(canSeeWorkspace(["ws1"], "ws1")).toBe(true);
    expect(canSeeWorkspace(["ws2"], "ws1")).toBe(false);
    expect(canSeeWorkspace([], "ws1")).toBe(false);
  });

  it("returns nobody for an account with no members", async () => {
    expect(await accountRecipients(client([], {}), "ag1", "ws1")).toEqual([]);
  });
});
