import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

// ---------------------------------------------------------------------------
// /connect/google: a site that is already a workspace, connected afterwards
// ---------------------------------------------------------------------------
//
// The callback links every site its consent covers, but only at the moment of
// consent. A new signup connects from the onboarding wizard with a Google
// account that cannot see their site yet, verifies it in Search Console, and
// comes back as the page tells them to. The site was then listed as "already
// a workspace" with nothing to press. These pin down the way through: stored
// consent plus an unconnected workspace ends connected.

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_WS = "22222222-2222-4222-8222-222222222222";
const SITE = "sc-domain:acme.co";

const requireAuth = vi.fn();
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: (...args: unknown[]) => requireAuth(...args) }));

let db: FakeSupabase;

/**
 * The person's own client may not write a site's Google token or property
 * (migration 111): the server writes it after its checks. Refused the way
 * PostgREST refuses, as an error in the result.
 */
function asMember(table: string) {
  const q = db.from(table);
  if (table !== "workspace_integrations" && table !== "account_integrations") return q;
  const result = { data: null, error: { message: "A Google connection is written by the server" } };
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "select", "single", "maybeSingle"]) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const deny = () => chain;
  return { ...q, insert: deny, upsert: deny, update: deny };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => asMember(table) }),
  createServiceClient: () => ({ from: (table: string) => db.from(table) }),
}));

vi.mock("@/lib/google/oauth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/google/oauth")>();
  return { ...real, getValidAccessToken: async () => "access-token" };
});

const listGSCSites = vi.fn();
vi.mock("@/lib/google/gsc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/google/gsc")>();
  return { ...real, listGSCSites: (...args: unknown[]) => listGSCSites(...args) };
});

const backfillAnalytics = vi.fn();
vi.mock("@/lib/google/sync", () => ({ backfillAnalytics: (...args: unknown[]) => backfillAnalytics(...args) }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/onboarding/run-dispatch", () => ({ dispatchWorker: vi.fn() }));

process.env.ENCRYPTION_KEY = "0".repeat(64);
const { encryptTokens } = await import("@/lib/google/oauth");
const { listDetectedProperties, connectPropertyToWorkspace } = await import("../google-properties");

const CONSENT = encryptTokens({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000 });

function seed(workspaces: Record<string, unknown>[], extra: Record<string, Record<string, unknown>[]> = {}) {
  db = fakeSupabase({
    workspaces,
    account_members: [{ id: "m1", account_id: "acc-1", user_id: "u1", role: "owner", workspace_ids: null }],
    workspace_integrations: [],
    account_integrations: [{ account_id: "acc-1", provider: "google", tokens: { encrypted: CONSENT } }],
    ...extra,
  });
}

beforeEach(() => {
  requireAuth.mockReset();
  requireAuth.mockResolvedValue({ user: { id: "u1", email: "owner@acme.co" }, accountId: "acc-1", role: "owner" });
  listGSCSites.mockReset();
  listGSCSites.mockResolvedValue([{ siteUrl: SITE, permissionLevel: "siteOwner" }]);
  backfillAnalytics.mockReset();
  backfillAnalytics.mockResolvedValue({ days: 7, gsc: 12, ga4: 0, errors: [] });
  seed([{ id: WS, account_id: "acc-1", domain: "acme.co" }]);
});

describe("connectPropertyToWorkspace", () => {
  it("stored consent + an existing unconnected workspace ends connected", async () => {
    const before = await listDetectedProperties();
    expect(before.properties).toEqual([
      expect.objectContaining({
        siteUrl: SITE,
        existingWorkspaceId: WS,
        existingConnected: false,
        existingNeedsReconnect: false,
        canRead: true,
      }),
    ]);

    const result = await connectPropertyToWorkspace(SITE);

    expect(result).toEqual({ ok: true, workspaceId: WS, synced: 12 });
    expect(db.tables.workspace_integrations).toEqual([
      expect.objectContaining({
        workspace_id: WS,
        integration_id: "gsc",
        config: { type: "gsc", gscSiteUrl: SITE },
        tokens: { encrypted: CONSENT },
        needs_reconnect: false,
      }),
    ]);
    expect(backfillAnalytics).toHaveBeenCalledWith(expect.anything(), WS, "gsc", 7);

    const after = await listDetectedProperties();
    expect(after.properties[0]).toMatchObject({ existingWorkspaceId: WS, existingConnected: true });
  });

  it("connects this account's site, not a same-domain site in another account the person belongs to", async () => {
    // RLS shows both; the picker's list keeps whichever came last.
    seed([
      { id: WS, account_id: "acc-1", domain: "www.acme.co" },
      { id: OTHER_ACCOUNT_WS, account_id: "acc-2", domain: "acme.co" },
    ]);
    const result = await connectPropertyToWorkspace(SITE);
    expect(result).toMatchObject({ ok: true, workspaceId: WS });
    expect(db.tables.workspace_integrations.map((r) => r.workspace_id)).toEqual([WS]);
  });

  it("refuses when the only site on that domain is in another account", async () => {
    seed([{ id: OTHER_ACCOUNT_WS, account_id: "acc-2", domain: "acme.co" }]);
    const result = await connectPropertyToWorkspace(SITE);
    expect(result.ok).toBe(false);
    expect(db.writes).toHaveLength(0);
  });

  it("refuses a property this Google account cannot read", async () => {
    listGSCSites.mockResolvedValue([{ siteUrl: SITE, permissionLevel: "siteRestrictedUser" }]);
    const result = await connectPropertyToWorkspace(SITE);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("full access") });
    expect(db.writes).toHaveLength(0);
  });

  it("refuses without a stored consent", async () => {
    seed([{ id: WS, account_id: "acc-1", domain: "acme.co" }], { account_integrations: [] });
    const result = await connectPropertyToWorkspace(SITE);
    expect(result.ok).toBe(false);
    expect(db.writes).toHaveLength(0);
  });

  it("leaves an already connected site as it is", async () => {
    seed([{ id: WS, account_id: "acc-1", domain: "acme.co" }], {
      workspace_integrations: [{ workspace_id: WS, integration_id: "gsc", config: { type: "gsc" }, needs_reconnect: false }],
    });
    const before = await listDetectedProperties();
    expect(before.properties[0]).toMatchObject({ existingConnected: true, existingNeedsReconnect: false });
    const result = await connectPropertyToWorkspace(SITE);
    expect(result).toEqual({ ok: true, workspaceId: WS, synced: 0 });
    expect(db.writes).toHaveLength(0);
  });
});

describe("a site whose Search Console token Google refused", () => {
  const DEAD = {
    workspace_id: WS,
    integration_id: "gsc",
    config: { type: "gsc", gscSiteUrl: SITE },
    tokens: { encrypted: "someone-else's-dead-token" },
    needs_reconnect: true,
    last_sync_error: "invalid_grant",
  };

  it("is listed as needing a reconnect, not as connected", async () => {
    seed([{ id: WS, account_id: "acc-1", domain: "acme.co" }], { workspace_integrations: [DEAD] });
    const { properties } = await listDetectedProperties();
    expect(properties[0]).toMatchObject({
      existingWorkspaceId: WS,
      existingConnected: false,
      existingNeedsReconnect: true,
    });
  });

  it("is written over with the stored consent on Reconnect", async () => {
    seed([{ id: WS, account_id: "acc-1", domain: "acme.co" }], { workspace_integrations: [DEAD] });
    const result = await connectPropertyToWorkspace(SITE);

    expect(result).toEqual({ ok: true, workspaceId: WS, synced: 12 });
    const inserts = db.writes.filter((w) => w.table === "workspace_integrations" && w.op === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].rows).toEqual([
      expect.objectContaining({
        workspace_id: WS,
        integration_id: "gsc",
        tokens: { encrypted: CONSENT },
        needs_reconnect: false,
        last_sync_error: null,
      }),
    ]);
    expect(backfillAnalytics).toHaveBeenCalledWith(expect.anything(), WS, "gsc", 7);
  });
});

describe("a member limited to some sites", () => {
  const OWN_WS = WS;
  const OTHER_WS = "44444444-4444-4444-8444-444444444444";
  const OTHER_SITE = "sc-domain:client-b.example";

  function limitedWorld() {
    seed(
      [
        { id: OWN_WS, account_id: "acc-1", domain: "acme.co" },
        // RLS hides the other client's site from this member, so the fake
        // does not hold it either.
      ],
      {
        account_members: [{ id: "m1", account_id: "acc-1", user_id: "u1", role: "editor", workspace_ids: [OWN_WS] }],
      },
    );
    listGSCSites.mockResolvedValue([
      { siteUrl: SITE, permissionLevel: "siteOwner" },
      { siteUrl: OTHER_SITE, permissionLevel: "siteOwner" },
    ]);
    void OTHER_WS;
  }

  it("sees only the properties of their own sites", async () => {
    limitedWorld();
    const { properties } = await listDetectedProperties();
    expect(properties.map((p) => p.siteUrl)).toEqual([SITE]);
  });

  it("cannot connect a property that is not one of their sites", async () => {
    limitedWorld();
    const result = await connectPropertyToWorkspace(OTHER_SITE);
    expect(result.ok).toBe(false);
    expect(db.writes).toHaveLength(0);
  });

  it("still connects their own site, written by the server", async () => {
    limitedWorld();
    const result = await connectPropertyToWorkspace(SITE);
    expect(result).toMatchObject({ ok: true, workspaceId: OWN_WS });
    expect(db.tables.workspace_integrations).toEqual([
      expect.objectContaining({ workspace_id: OWN_WS, config: { type: "gsc", gscSiteUrl: SITE } }),
    ]);
  });

  it("creates no site from the account's Google properties", async () => {
    limitedWorld();
    requireAuth.mockResolvedValue({ user: { id: "u1", email: "admin@acme.co" }, accountId: "acc-1", role: "admin" });
    const { createWorkspacesFromProperties } = await import("../google-properties");
    const result = await createWorkspacesFromProperties([OTHER_SITE]);
    expect(result).toMatchObject({ ok: true, created: 0 });
    expect(db.writes.filter((w) => w.table === "workspaces" || w.table === "workspace_integrations")).toHaveLength(0);
  });
});
