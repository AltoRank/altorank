import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A user who belongs to two agencies could not do anything.
 *
 * requireAuth read the membership with `.single()`, which PostgREST refuses
 * when more than one row matches, so accepting a second invitation locked the
 * person out of every server action (settings track, 2026-09-04). The
 * membership is now chosen deterministically: the agency of the workspace they
 * are looking at when the scope cookie names one, else the one they have held
 * longest.
 */

type Member = { agency_id: string; role: string; created_at: string };

let members: Member[] = [];
/** agency_id the scoped workspace resolves to, or null for "not found". */
let workspaceAgency: string | null = null;
let cookie: string | undefined;
let workspaceLookups: string[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "active_workspace" && cookie ? { value: cookie } : undefined),
  }),
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
            data: workspaceAgency ? { agency_id: workspaceAgency } : null,
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
      if (table === "agency_members") return membersQuery();
      if (table === "workspaces") return workspacesQuery();
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const OLD = { agency_id: "agency-old", role: "editor", created_at: "2026-01-01T00:00:00Z" };
const NEW = { agency_id: "agency-new", role: "owner", created_at: "2026-06-01T00:00:00Z" };

async function auth(roles?: string[]) {
  const { requireAuth } = await import("../require-auth");
  return requireAuth(roles);
}

beforeEach(() => {
  members = [];
  workspaceAgency = null;
  cookie = undefined;
  workspaceLookups = [];
});

describe("requireAuth", () => {
  it("returns the one membership a single-agency user has, without looking up a workspace", async () => {
    members = [OLD];
    cookie = "ws-1";
    const ctx = await auth();
    expect(ctx).toMatchObject({ agencyId: "agency-old", role: "editor" });
    expect(ctx.user.id).toBe("user-1");
    expect(workspaceLookups).toEqual([]);
  });

  it("throws when the user belongs to no agency", async () => {
    await expect(auth()).rejects.toThrow("No agency membership found");
  });

  it("picks the oldest membership when two exist and nothing is in scope", async () => {
    // Newest listed first: the choice must come from ordering, not from
    // whatever row the database happened to return first.
    members = [NEW, OLD];
    const ctx = await auth();
    expect(ctx).toMatchObject({ agencyId: "agency-old", role: "editor" });
  });

  it("follows the active workspace's agency when the scope cookie names one", async () => {
    members = [NEW, OLD];
    cookie = "ws-new";
    workspaceAgency = "agency-new";
    const ctx = await auth();
    expect(ctx).toMatchObject({ agencyId: "agency-new", role: "owner" });
    expect(workspaceLookups).toEqual(["ws-new"]);
  });

  it("falls back to the oldest membership when the scoped workspace does not resolve", async () => {
    members = [NEW, OLD];
    cookie = "ws-gone";
    workspaceAgency = null;
    expect(await auth()).toMatchObject({ agencyId: "agency-old" });
  });

  it("checks required roles against the membership it chose", async () => {
    members = [NEW, OLD];
    await expect(auth(["owner"])).rejects.toThrow("Insufficient permissions");
    cookie = "ws-new";
    workspaceAgency = "agency-new";
    expect(await auth(["owner"])).toMatchObject({ role: "owner" });
  });
});
