import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Team actions: a member limited to some sites acts within them
// ---------------------------------------------------------------------------
//
// The rules themselves are in lib/team/access.ts (and its tests); these check
// the actions apply them before anything is written: the invite, the access
// dialog, and the role-only save.

const ACTOR = "u-actor";
const ACCOUNT = "account-1";

/** The signed-in member's own sites; null is every site. */
let actorSites: string[] | null = null;
/** The member being edited. */
let target: { id: string; user_id: string; role: string; workspace_ids: string[] | null } = {
  id: "m-target",
  user_id: "u-target",
  role: "editor",
  workspace_ids: ["ws-a"],
};
/** What the caller's RLS shows of the account's sites. */
let visibleSites: string[] = ["ws-a", "ws-b"];

const updates: Record<string, unknown>[] = [];
const inserts: Record<string, unknown>[] = [];

function reads(table: string) {
  const filters: Record<string, unknown> = {};
  const q: Record<string, unknown> = {};
  const chain = (col?: string, value?: unknown) => {
    if (col) filters[col] = value;
    return q as never;
  };
  const one = () => {
    if (table === "account_members") {
      if (filters.user_id === ACTOR) return { workspace_ids: actorSites };
      if (filters.id === target.id) return target;
      return null;
    }
    if (table === "invites") return null;
    return null;
  };
  Object.assign(q, {
    select: () => q,
    eq: chain,
    ilike: chain,
    is: chain,
    single: () => Promise.resolve({ data: table === "accounts" ? { name: "Acme" } : null, error: null }),
    maybeSingle: () => Promise.resolve({ data: one(), error: null }),
    then: (r: (v: unknown) => unknown) =>
      r({ data: table === "workspaces" ? visibleSites.map((id) => ({ id })) : null, error: null }),
  });
  return q as never;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => ({
      select: () => reads(table),
      insert: (row: Record<string, unknown>) => {
        inserts.push({ table, ...row });
        return Promise.resolve({ error: null });
      },
      update: (row: Record<string, unknown>) => {
        updates.push({ table, ...row });
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  }),
}));

const { requireAuth } = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => ({
    accountId: "account-1",
    role: "admin",
    user: { id: "u-actor", email: "admin@acme.test", user_metadata: {} },
  })),
}));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth }));
vi.mock("@/lib/email/resend", () => ({ sendInviteEmail: vi.fn(async () => "email-id") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeEach(() => {
  actorSites = null;
  target = { id: "m-target", user_id: "u-target", role: "editor", workspace_ids: ["ws-a"] };
  visibleSites = ["ws-a", "ws-b"];
  updates.length = 0;
  inserts.length = 0;
  void ACCOUNT;
});

function inviteForm(sites: string[], role = "editor") {
  const fd = new FormData();
  fd.set("email", "new@acme.test");
  fd.set("role", role);
  for (const s of sites) fd.append("workspace_ids", s);
  return fd;
}

describe("updateMemberAccess for a member with every site", () => {
  it("still stores an empty selection as every site", async () => {
    const { updateMemberAccess } = await import("../team");
    await updateMemberAccess("m-target", "editor", []);
    expect(updates).toEqual([{ table: "account_members", role: "editor", workspace_ids: null }]);
  });
});

describe("updateMemberAccess for a member limited to some sites", () => {
  beforeEach(() => {
    actorSites = ["ws-a"];
    visibleSites = ["ws-a"];
  });

  it("refuses an empty selection instead of storing every site", async () => {
    const { updateMemberAccess } = await import("../team");
    await expect(updateMemberAccess("m-target", "editor", [])).rejects.toThrow(/at least one site/);
    expect(updates).toHaveLength(0);
  });

  it("drops sites outside the actor's own", async () => {
    target = { ...target, workspace_ids: ["ws-a"] };
    const { updateMemberAccess } = await import("../team");
    await updateMemberAccess("m-target", "editor", ["ws-a", "ws-b", "ws-z"]);
    expect(updates[0].workspace_ids).toEqual(["ws-a"]);
  });

  it("keeps the target's sites the actor cannot see", async () => {
    target = { ...target, workspace_ids: ["ws-a", "ws-b"] };
    const { updateMemberAccess } = await import("../team");
    await updateMemberAccess("m-target", "editor", ["ws-a"]);
    expect(updates[0].workspace_ids).toEqual(expect.arrayContaining(["ws-a", "ws-b"]));
    expect((updates[0].workspace_ids as string[]).length).toBe(2);
  });

  it("leaves a member with every site alone", async () => {
    target = { ...target, workspace_ids: null };
    const { updateMemberAccess } = await import("../team");
    await expect(updateMemberAccess("m-target", "editor", ["ws-a"])).rejects.toThrow(/every site/);
    expect(updates).toHaveLength(0);
  });

  it("does not change the role of a member who reaches further", async () => {
    target = { ...target, workspace_ids: ["ws-a", "ws-b"] };
    const { updateMemberAccess } = await import("../team");
    await expect(updateMemberAccess("m-target", "admin", ["ws-a"])).rejects.toThrow(/sites you do not/);
    expect(updates).toHaveLength(0);
  });

  it("changes the role of a member inside the actor's sites", async () => {
    target = { ...target, workspace_ids: ["ws-a"] };
    const { updateMemberAccess } = await import("../team");
    await updateMemberAccess("m-target", "admin", ["ws-a"]);
    expect(updates[0]).toMatchObject({ role: "admin", workspace_ids: ["ws-a"] });
  });

  it("a role-only save keeps the target's list as it was", async () => {
    target = { ...target, workspace_ids: ["ws-a", "ws-b"] };
    const { updateMemberRole } = await import("../team");
    await updateMemberRole("m-target", "editor");
    expect(updates[0].workspace_ids).toEqual(expect.arrayContaining(["ws-a", "ws-b"]));
  });
});

describe("inviteMember for a member limited to some sites", () => {
  beforeEach(() => {
    actorSites = ["ws-a"];
    visibleSites = ["ws-a"];
  });

  it("refuses an invite to every site", async () => {
    const { inviteMember } = await import("../team");
    await expect(inviteMember(inviteForm([]))).rejects.toThrow(/at least one site/);
    expect(inserts).toHaveLength(0);
  });

  it("invites to the actor's own sites only", async () => {
    const { inviteMember } = await import("../team");
    await inviteMember(inviteForm(["ws-a", "ws-b"]));
    const [row] = inserts.filter((r) => r.table === "invites");
    expect(row.workspace_ids).toEqual(["ws-a"]);
  });

  it("an actor with every site still invites to every site", async () => {
    actorSites = null;
    visibleSites = ["ws-a", "ws-b"];
    const { inviteMember } = await import("../team");
    await inviteMember(inviteForm([]));
    const [row] = inserts.filter((r) => r.table === "invites");
    expect(row.workspace_ids).toBeNull();
  });
});
