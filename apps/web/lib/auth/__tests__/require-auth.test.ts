import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A user who belongs to two accounts could not do anything.
 *
 * requireAuth read the membership with `.single()`, which PostgREST refuses
 * when more than one row matches, so accepting a second invitation locked the
 * person out of every server action (settings track, 2026-09-04). The
 * membership is now chosen deterministically: the account of the site the
 * call acts on when it names one, else the account of the site in scope
 * (lib/workspace-scope.ts - the same answer the dashboard layout gates on),
 * else the one they have held longest.
 *
 * The scope itself - and its choice of a site when nothing names one - is
 * lib/workspace-scope.ts's, tested with the real trial gate in
 * lib/__tests__/workspace-scope-gate.test.ts. Here it is the input.
 */

type Member = { account_id: string; role: string; created_at: string };

let members: Member[] = [];
/** The account of the site `workspaceId` names, or null for "not visible". */
let workspaceAccount: string | null = null;
let scope: { workspaceId: string; accountId: string } | null = null;
let workspaceLookups: string[] = [];
let scopeReads = 0;

vi.mock("@/lib/workspace-scope", () => ({
  getScope: async () => {
    scopeReads += 1;
    return scope;
  },
}));

// Enough of the PostgREST builder to answer both the old query and the new
// one. `.single()` keeps its real contract - one row or an error - so the case
// this file exists for fails the way it failed in production.
function membersQuery() {
  let rows = [...members];
  const q = {
    eq: () => q,
    order: (col: keyof Member, opts?: { ascending?: boolean }) => {
      const dir = opts?.ascending === false ? -1 : 1;
      rows = [...rows].sort((a, b) => (a[col] < b[col] ? -dir : a[col] > b[col] ? dir : 0));
      return q;
    },
    single: async () =>
      rows.length === 1
        ? { data: rows[0], error: null }
        : { data: null, error: { code: "PGRST116", message: `${rows.length} rows` } },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
  };
  return { select: () => q };
}

function workspacesQuery() {
  return {
    select: () => ({
      eq: (_col: string, id: string) => {
        workspaceLookups.push(id);
        return {
          maybeSingle: async () => ({
            data: workspaceAccount ? { account_id: workspaceAccount } : null,
            error: null,
          }),
        };
      },
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => {
      if (table === "account_members") return membersQuery();
      if (table === "workspaces") return workspacesQuery();
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const OLD = { account_id: "account-old", role: "editor", created_at: "2026-01-01T00:00:00Z" };
const NEW = { account_id: "account-new", role: "owner", created_at: "2026-06-01T00:00:00Z" };

async function auth(roles?: string[], opts?: { workspaceId?: string }) {
  const { requireAuth } = await import("../require-auth");
  return requireAuth(roles, opts);
}

beforeEach(() => {
  members = [];
  workspaceAccount = null;
  scope = null;
  workspaceLookups = [];
  scopeReads = 0;
});

describe("requireAuth", () => {
  it("returns the one membership a single-account user has, without asking for the scope", async () => {
    members = [OLD];
    scope = { workspaceId: "ws-1", accountId: "account-old" };
    const ctx = await auth();
    expect(ctx).toMatchObject({ accountId: "account-old", role: "editor" });
    expect(ctx.user.id).toBe("user-1");
    expect(scopeReads).toBe(0);
  });

  it("throws when the user belongs to no account", async () => {
    await expect(auth()).rejects.toThrow("No account membership found");
  });

  it("picks the oldest membership when two exist and no site is visible", async () => {
    // Newest listed first: the choice must come from ordering, not from
    // whatever row the database happened to return first.
    members = [NEW, OLD];
    const ctx = await auth();
    expect(ctx).toMatchObject({ accountId: "account-old", role: "editor" });
  });

  it("follows the scoped site's account, whatever the membership order", async () => {
    members = [NEW, OLD];
    scope = { workspaceId: "ws-new", accountId: "account-new" };
    expect(await auth()).toMatchObject({ accountId: "account-new", role: "owner" });
  });

  it("answers for the account of the site the call names, over the scope", async () => {
    // Round-4 review: a paid action on a site of the paying account must not
    // ask the gate about the person's own never-trialed account because the
    // scope happens to sit there.
    members = [NEW, OLD];
    scope = { workspaceId: "ws-old", accountId: "account-old" };
    workspaceAccount = "account-new";
    expect(await auth(undefined, { workspaceId: "ws-new" })).toMatchObject({ accountId: "account-new", role: "owner" });
    expect(workspaceLookups).toEqual(["ws-new"]);
    expect(scopeReads).toBe(0);
  });

  it("refuses a named site the person cannot see", async () => {
    members = [OLD];
    workspaceAccount = null;
    await expect(auth(undefined, { workspaceId: "someone-elses" })).rejects.toThrow("Workspace not found");
  });

  it("checks required roles against the membership it chose", async () => {
    members = [NEW, OLD];
    await expect(auth(["owner"])).rejects.toThrow("Insufficient permissions");
    scope = { workspaceId: "ws-new", accountId: "account-new" };
    expect(await auth(["owner"])).toMatchObject({ role: "owner" });
    // And against the named site's account when there is one.
    workspaceAccount = "account-old";
    await expect(auth(["owner"], { workspaceId: "ws-old" })).rejects.toThrow("Insufficient permissions");
  });
});
