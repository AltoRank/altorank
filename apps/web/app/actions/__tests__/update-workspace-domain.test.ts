import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// updateWorkspace: a site's domain is moved by a member with every site
// ---------------------------------------------------------------------------
//
// A site's Search Console, Analytics and Bing connections are matched to its
// domain with credentials that see the account's other sites, so a member
// limited to some sites keeps the domain their site has. Everything else on
// the form, and a domain sent back unchanged, still saves.

let actorSites: string[] | null = null;
let currentDomain = "one.acme.test";
const updates: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: (col: string, value: unknown) => {
          filters[col] = value;
          return q;
        },
        maybeSingle: async () => ({
          data: table === "account_members" ? { workspace_ids: actorSites } : { domain: currentDomain },
          error: null,
        }),
        update: (row: Record<string, unknown>) => {
          updates.push({ table, ...row });
          const done: Record<string, unknown> = {};
          Object.assign(done, { eq: () => done, then: (r: (v: unknown) => unknown) => r({ error: null }) });
          return done;
        },
      });
      return q;
    },
  }),
  createServiceClient: () => ({}),
}));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ accountId: "account-1", role: "admin", user: { id: "u-actor", email: "a@acme.test" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  actorSites = null;
  currentDomain = "one.acme.test";
  updates.length = 0;
});

describe("updateWorkspace and the site's domain", () => {
  it("a member limited to some sites cannot move the domain", async () => {
    actorSites = ["ws-1"];
    const { updateWorkspace } = await import("../workspaces");
    for (const domain of ["client-b.test", "x.client-b.test", "https://www.client-b.test/"]) {
      await expect(updateWorkspace("ws-1", form({ domain }))).rejects.toThrow(/every site/);
    }
    expect(updates).toHaveLength(0);
  });

  it("a member limited to some sites still saves the rest, and the domain it already has", async () => {
    actorSites = ["ws-1"];
    currentDomain = "One.Acme.test";
    const { updateWorkspace } = await import("../workspaces");
    await updateWorkspace("ws-1", form({ name: "Client one" }));
    await updateWorkspace("ws-1", form({ domain: "https://www.one.acme.test/" }));
    expect(updates).toEqual([
      { table: "workspaces", name: "Client one" },
      { table: "workspaces", domain: "one.acme.test" },
    ]);
  });

  it("a member with every site moves the domain", async () => {
    const { updateWorkspace } = await import("../workspaces");
    await updateWorkspace("ws-1", form({ domain: "two.acme.test" }));
    expect(updates).toEqual([{ table: "workspaces", domain: "two.acme.test" }]);
  });
});
