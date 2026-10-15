import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  process.env.SHOPIFY_API_SECRET = "shpss_secret";
  process.env.ENCRYPTION_KEY = "0".repeat(64);
});

import { encryptConfig, decryptConfig } from "@/lib/crypto";
import {
  LINK_TTL_MS,
  linkStore,
  readLinkSource,
  signLinkToken,
  sourceRetirementBlocker,
  verifyLinkToken,
  type LinkSource,
} from "../link";

const NOW = 1_800_000_000_000;
const claims = { installationId: "inst-1", shop: "fern.myshopify.com", fromAccountId: "acc-store" };

describe("link token", () => {
  it("round-trips", () => {
    const v = verifyLinkToken(signLinkToken(claims, NOW), NOW + 1000);
    expect(v).toMatchObject({ ok: true, payload: claims });
  });

  it("refuses a forged or altered token", () => {
    const token = signLinkToken(claims, NOW)!;
    const [body, sig] = token.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ ...claims, installationId: "inst-OTHER", exp: NOW + LINK_TTL_MS })).toString("base64url");
    expect(verifyLinkToken(`${forgedBody}.${sig}`, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
    expect(verifyLinkToken(`${body}.AAAA${sig.slice(4)}`, NOW).ok).toBe(false);
    expect(verifyLinkToken("nonsense", NOW).ok).toBe(false);
    expect(verifyLinkToken(undefined, NOW).ok).toBe(false);
  });

  it("expires after fifteen minutes", () => {
    const token = signLinkToken(claims, NOW);
    expect(verifyLinkToken(token, NOW + LINK_TTL_MS + 1)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });

  it("is signed with this server's Shopify secret only", () => {
    const token = signLinkToken(claims, NOW);
    process.env.SHOPIFY_API_SECRET = "another";
    expect(verifyLinkToken(token, NOW).ok).toBe(false);
    process.env.SHOPIFY_API_SECRET = "shpss_secret";
  });
});

// ---------------------------------------------------------------------------
// A small in-memory Supabase for the link's reads and writes.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
function fakeDb(seed: Record<string, Row[]>, opts: { failUpsert?: boolean; users?: Row[] } = {}) {
  const tables: Record<string, Row[]> = { shopify_installations: [], accounts: [], account_members: [], workspace_integrations: [], articles: [], ...seed };
  const users = opts.users ?? [];
  const deletedUsers: string[] = [];
  const from = (table: string) => {
    let op = "select";
    let values: Row = {};
    let head = false;
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => tables[table] ?? [];
    const matching = () => rows().filter((r) => filters.every((f) => f(r)));
    const run = () => {
      if (op === "update") {
        const hit = matching();
        hit.forEach((r) => Object.assign(r, values));
        return hit;
      }
      if (op === "delete") {
        const hit = matching();
        tables[table] = rows().filter((r) => !hit.includes(r));
        if (table === "accounts") {
          const ids = hit.map((r) => r.id);
          tables.account_members = tables.account_members.filter((m) => !ids.includes(m.account_id));
          tables.workspace_integrations = tables.workspace_integrations.filter((w) => !ids.includes(w.account_id));
        }
        return hit;
      }
      return matching();
    };
    const b: Record<string, unknown> = {
      select: (_c?: string, o?: { head?: boolean }) => ((head = Boolean(o?.head)), b),
      update: (v: Row) => ((op = "update"), (values = v), b),
      delete: () => ((op = "delete"), b),
      upsert: async (v: Row) => {
        if (opts.failUpsert) return { error: { message: "boom" } };
        const existing = rows().find((r) => r.workspace_id === v.workspace_id && r.integration_id === v.integration_id);
        if (existing) Object.assign(existing, v);
        else (tables[table] ??= []).push({ ...v });
        return { error: null };
      },
      eq: (c: string, v: unknown) => (filters.push((r) => (c === "workspaces.account_id" ? r.account_id === v : r[c] === v)), b),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
      maybeSingle: async () => ({ data: run()[0] ?? null }),
      then: (res: (v: unknown) => void) => {
        const data = run();
        res(head ? { count: data.length, data: null } : { data, error: null });
      },
    };
    return b;
  };
  return {
    db: {
      from,
      auth: {
        admin: {
          getUserById: async (id: string) => ({ data: { user: users.find((u) => u.id === id) ?? null } }),
          deleteUser: async (id: string) => (deletedUsers.push(id), { error: null }),
        },
      },
    } as never,
    tables,
    deletedUsers,
  };
}

const installation = (over: Row = {}): Row => ({
  id: "inst-1",
  shop_domain: "fern.myshopify.com",
  shop_name: "Fern",
  primary_domain: "fern.com",
  account_id: "acc-store",
  workspace_id: "ws-store",
  uninstalled_at: null,
  ...over,
});
const payload = { ...claims, exp: NOW + LINK_TTL_MS, nonce: "n" };
const source: LinkSource = {
  installationId: "inst-1",
  shop: "fern.myshopify.com",
  shopName: "Fern",
  domain: "fern.com",
  fromAccountId: "acc-store",
  fromWorkspaceId: "ws-store",
};

describe("readLinkSource", () => {
  it("reads a store still on the account the link names", async () => {
    const { db } = fakeDb({ shopify_installations: [installation()] });
    expect(await readLinkSource(db, payload)).toMatchObject({ installationId: "inst-1", domain: "fern.com" });
  });

  it("refuses a link that was already used (the store moved)", async () => {
    const { db } = fakeDb({ shopify_installations: [installation({ account_id: "acc-elsewhere" })] });
    expect(await readLinkSource(db, payload)).toMatchObject({ error: expect.stringMatching(/already used/) });
  });

  it("refuses an uninstalled store", async () => {
    const { db } = fakeDb({ shopify_installations: [installation({ uninstalled_at: "2026-10-01" })] });
    expect(await readLinkSource(db, payload)).toMatchObject({ error: expect.stringMatching(/no longer installed/) });
  });
});

describe("sourceRetirementBlocker", () => {
  it("lets an untouched install account go", async () => {
    const { db } = fakeDb({
      accounts: [{ id: "acc-store", billing_provider: "stripe", plan_status: "inactive" }],
      account_members: [{ id: "m1", account_id: "acc-store", user_id: "u-store" }],
      articles: [{ id: "a1", account_id: "acc-store", status: "review" }],
    });
    expect(await sourceRetirementBlocker(db, source)).toBeNull();
  });

  it.each([
    ["it pays through Shopify", { accounts: [{ id: "acc-store", billing_provider: "shopify", plan_status: "active" }] }, /pays for AltoRank through Shopify/],
    ["an article was published from it", { articles: [{ id: "a1", account_id: "acc-store", status: "live" }] }, /approved or published/],
    ["someone else was invited", { account_members: [{ id: "m1", account_id: "acc-store" }, { id: "m2", account_id: "acc-store" }] }, /invited/],
  ])("refuses to retire it when %s", async (_l, seed, message) => {
    const { db } = fakeDb({ accounts: [{ id: "acc-store", billing_provider: "stripe", plan_status: "inactive" }], ...seed });
    expect(await sourceRetirementBlocker(db, source)).toMatch(message);
  });
});

describe("linkStore", () => {
  function seeded(extra: Record<string, Row[]> = {}, opts = {}) {
    return fakeDb(
      {
        shopify_installations: [installation()],
        accounts: [{ id: "acc-store" }, { id: "acc-me" }],
        account_members: [
          { id: "m1", account_id: "acc-store", user_id: "u-store" },
          { id: "m2", account_id: "acc-me", user_id: "u-me" },
        ],
        workspace_integrations: [
          {
            account_id: "acc-store",
            workspace_id: "ws-store",
            integration_id: "shopify",
            publish_mode: "publish",
            config: encryptConfig({ type: "shopify", storeUrl: "https://fern.myshopify.com", installationId: "inst-1", blogId: "7", blogHandle: "news" }),
          },
        ],
        ...extra,
      },
      { users: [{ id: "u-store", user_metadata: { shopify_shop: "fern.myshopify.com" } }, { id: "u-me", user_metadata: {} }], ...opts },
    );
  }

  it("moves the store, keeps its blog and publish mode, and retires the install's account", async () => {
    const { db, tables, deletedUsers } = seeded();
    expect(await linkStore(db, source, { accountId: "acc-me", workspaceId: "ws-mine" })).toEqual({ ok: true, workspaceId: "ws-mine" });

    expect(tables.shopify_installations[0]).toMatchObject({ account_id: "acc-me", workspace_id: "ws-mine" });
    const conn = tables.workspace_integrations.find((w) => w.workspace_id === "ws-mine")!;
    expect(conn.publish_mode).toBe("publish");
    expect(decryptConfig(conn.config as Row)).toMatchObject({ installationId: "inst-1", blogId: "7", blogHandle: "news" });
    expect(tables.accounts.map((a) => a.id)).toEqual(["acc-me"]);
    // Only the owner the install created, never the person linking.
    expect(deletedUsers).toEqual(["u-store"]);
  });

  it("is single-use: a second run finds nothing to move", async () => {
    const { db } = seeded();
    await linkStore(db, source, { accountId: "acc-me", workspaceId: "ws-mine" });
    expect(await linkStore(db, source, { accountId: "acc-me", workspaceId: "ws-mine" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already used/),
    });
  });

  it("refuses a site already connected to a different Shopify store, moving nothing", async () => {
    const { db, tables } = seeded({
      workspace_integrations: [
        {
          workspace_id: "ws-mine",
          integration_id: "shopify",
          config: encryptConfig({ type: "shopify", storeUrl: "https://other.myshopify.com", accessToken: "shpat_x" }),
        },
      ],
    });
    expect(await linkStore(db, source, { accountId: "acc-me", workspaceId: "ws-mine" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/different Shopify store/),
    });
    expect(tables.shopify_installations[0].account_id).toBe("acc-store");
  });

  it("puts the store back if the site cannot be connected", async () => {
    const { db, tables } = seeded({}, { failUpsert: true });
    expect((await linkStore(db, source, { accountId: "acc-me", workspaceId: "ws-mine" })).ok).toBe(false);
    expect(tables.shopify_installations[0]).toMatchObject({ account_id: "acc-store", workspace_id: "ws-store" });
    expect(tables.accounts).toHaveLength(2);
  });

  it("refuses linking a store to the account it is already on", async () => {
    const { db } = seeded();
    expect(await linkStore(db, source, { accountId: "acc-store", workspaceId: "ws-store" })).toMatchObject({ ok: false });
  });
});
