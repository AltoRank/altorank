/**
 * A store's first open: account, owner, site and connection, with the
 * store's email trusted for a mailbox and nothing more.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  return { queryShopify: vi.fn(), listShopifyBlogs: vi.fn(), recordEvent: vi.fn() };
});
vi.mock("@/lib/cms/shopify", () => ({ queryShopify: m.queryShopify, listShopifyBlogs: m.listShopifyBlogs }));
vi.mock("@/lib/observability/record", () => ({ recordEvent: m.recordEvent }));

import { provisionShop } from "../provision";

type Row = Record<string, unknown>;

function fakeAdmin(opts: { takenEmails?: string[]; installation?: Row; raceLost?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    shopify_installations: [{ id: "inst-1", account_id: null, workspace_id: null, ...opts.installation }],
    accounts: [],
    account_members: [],
    workspaces: [],
    workspace_integrations: [],
  };
  const users: Row[] = (opts.takenEmails ?? []).map((email, i) => ({ id: `existing-${i}`, email }));
  const deletedUsers: string[] = [];
  let n = 0;

  const from = (table: string) => {
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let values: Row = {};
    const filters: Array<(r: Row) => boolean> = [];
    const run = () => {
      const rows = tables[table];
      if (op === "insert" || op === "upsert") {
        const row = { id: `${table}-${++n}`, ...values };
        rows.push(row);
        return [row];
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        if (table === "shopify_installations" && opts.raceLost) return [];
        hit.forEach((r) => Object.assign(r, values));
      }
      if (op === "delete") tables[table] = rows.filter((r) => !hit.includes(r));
      return hit;
    };
    const b = {
      select: () => b,
      insert: (v: Row) => ((op = "insert"), (values = v), b),
      upsert: (v: Row) => ((op = "upsert"), (values = v), b),
      update: (v: Row) => ((op = "update"), (values = v), b),
      delete: () => ((op = "delete"), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (res: (v: unknown) => void) => res({ data: run(), error: null }),
    };
    return b;
  };
  const admin = {
    from,
    auth: {
      admin: {
        createUser: async ({ email, user_metadata }: { email: string; user_metadata: Row }) => {
          if (users.some((u) => u.email === email)) return { data: { user: null }, error: { message: "A user with this email address has already been registered" } };
          const user = { id: `user-${users.length + 1}`, email, user_metadata };
          users.push(user);
          return { data: { user }, error: null };
        },
        deleteUser: async (id: string) => (deletedUsers.push(id), { error: null }),
      },
    },
  };
  return { admin: admin as never, tables, users, deletedUsers };
}

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.queryShopify.mockResolvedValue({
    shop: { name: "Fern & Co", email: "Owner@Fern.com", myshopifyDomain: "fern.myshopify.com", primaryDomain: { host: "www.fern.com" } },
  });
  m.listShopifyBlogs.mockResolvedValue([{ id: "7", title: "News", handle: "news" }]);
});

describe("provisionShop", () => {
  it("creates the owner, account, site for the storefront domain, and a draft-mode connection", async () => {
    const { admin, tables, users } = fakeAdmin();
    const out = await provisionShop(admin, { id: "inst-1", shop: "fern.myshopify.com" });

    expect(out).toMatchObject({ created: true, ownerReachable: true });
    expect(users[0]).toMatchObject({ email: "owner@fern.com" });
    expect(tables.accounts[0]).toMatchObject({ name: "Fern & Co", slug: "fern-co" });
    expect(tables.account_members[0]).toMatchObject({ role: "owner", user_id: users[0].id });
    expect(tables.workspaces[0]).toMatchObject({ domain: "fern.com", auto_generate: true });
    expect(tables.workspaces[0]).not.toHaveProperty("auto_approve");
    expect(tables.workspace_integrations[0]).toMatchObject({ integration_id: "shopify", publish_mode: "draft" });
    expect((tables.workspace_integrations[0].config as Row).installationId).toBe("inst-1");
    expect(tables.shopify_installations[0]).toMatchObject({ account_id: out.accountId, workspace_id: out.workspaceId });
  });

  it("never attaches the store to an existing AltoRank user who shares its email", async () => {
    const { admin, tables, users } = fakeAdmin({ takenEmails: ["owner@fern.com"] });
    const out = await provisionShop(admin, { id: "inst-1", shop: "fern.myshopify.com" });

    expect(out.ownerReachable).toBe(false);
    const owner = users.find((u) => u.id === tables.account_members[0].user_id)!;
    expect(owner.id).not.toBe("existing-0");
    expect(owner.email).toMatch(/@shopify-store\.altorank\.invalid$/);
  });

  it("returns what an earlier open set up, creating nothing", async () => {
    const { admin, tables } = fakeAdmin({ installation: { account_id: "acc-9", workspace_id: "ws-9" } });
    expect(await provisionShop(admin, { id: "inst-1", shop: "fern.myshopify.com" })).toMatchObject({
      accountId: "acc-9",
      workspaceId: "ws-9",
      created: false,
    });
    expect(tables.accounts).toHaveLength(0);
    expect(m.queryShopify).not.toHaveBeenCalled();
  });

  it("undoes its own account and owner when it fails partway", async () => {
    m.listShopifyBlogs.mockResolvedValue([]);
    const { admin, tables, deletedUsers } = fakeAdmin();
    // Fail the connection write.
    const from = (admin as { from: (t: string) => unknown }).from;
    (admin as { from: (t: string) => unknown }).from = (t: string) =>
      t === "workspace_integrations"
        ? { upsert: async () => ({ error: { message: "boom" } }) }
        : from(t);

    await expect(provisionShop(admin, { id: "inst-1", shop: "fern.myshopify.com" })).rejects.toThrow(/boom/);
    expect(tables.accounts).toHaveLength(0);
    expect(deletedUsers).toHaveLength(1);
  });
});
