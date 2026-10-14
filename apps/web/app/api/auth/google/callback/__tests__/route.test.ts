import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import { encodeOauthState, newOauthNonce, OAUTH_STATE_COOKIE } from "@/lib/google/oauth-state";
import { GA4_SCOPE, GSC_SCOPE } from "@/lib/google/oauth";

// ---------------------------------------------------------------------------
// GET /api/auth/google/callback: what a consent is allowed to connect
// ---------------------------------------------------------------------------
//
// Two things this pins down. The account-level branch (state `account:…`),
// unreachable until /api/auth/google stopped looking up a null workspace,
// must connect the sites the account already has: the onboarding wizard
// connects from there while its site exists, and the picker it lands on only
// offers properties that are not a workspace yet. And since Search Console
// and Analytics are separate consents, a row is written only for what the
// token was actually granted.

const WS = "11111111-1111-4111-8111-111111111111";
const WS_NO_PROPERTY = "33333333-3333-4333-8333-333333333333";
const OTHER_ACCOUNT_WS = "22222222-2222-4222-8222-222222222222";

const requireAuth = vi.fn();
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: (...args: unknown[]) => requireAuth(...args) }));

let db: FakeSupabase;
/** Set to make the service-role write of the account consent fail too. */
let serviceRefuses = false;

/**
 * A write PostgREST answers with an RLS refusal: an error in the result, no
 * throw, which is exactly what an unchecked `await` swallows.
 */
function refused(message: string) {
  const result = { data: null, error: { message } };
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "select", "single", "maybeSingle"]) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

/**
 * The person's own client, with the one policy that matters here: members
 * may read `account_integrations` but not write it (migration 033 gives the
 * table a SELECT policy and nothing else). The plain fake has no RLS, which
 * is how a callback writing the consent with this client passed its tests
 * while the write was refused in production.
 */
function asMember(table: string) {
  const q = db.from(table);
  if (table !== "account_integrations") return q;
  const deny = () => refused('new row violates row-level security policy for table "account_integrations"');
  return { ...q, insert: deny, upsert: deny, update: deny, delete: deny };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => asMember(table),
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
  }),
  createServiceClient: () => ({
    from: (table: string) => {
      if (serviceRefuses && table === "account_integrations") {
        const deny = () => refused("service write failed");
        return { ...db.from(table), upsert: deny };
      }
      return db.from(table);
    },
  }),
}));

const exchangeCode = vi.fn();
vi.mock("@/lib/google/oauth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/google/oauth")>();
  return {
    ...real,
    exchangeCode: (...args: unknown[]) => exchangeCode(...args),
    getValidAccessToken: async () => "access-token",
  };
});

const listGSCSites = vi.fn();
vi.mock("@/lib/google/gsc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/google/gsc")>();
  return { ...real, listGSCSites: (...args: unknown[]) => listGSCSites(...args) };
});

const listGA4Properties = vi.fn();
vi.mock("@/lib/google/ga4", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/google/ga4")>();
  return { ...real, listGA4Properties: (...args: unknown[]) => listGA4Properties(...args) };
});

const backfillAnalytics = vi.fn();
vi.mock("@/lib/google/sync", () => ({ backfillAnalytics: (...args: unknown[]) => backfillAnalytics(...args) }));

const { GET } = await import("../route");

function callback(workspaceId: string, integrationId: string) {
  const nonce = newOauthNonce();
  const request = new NextRequest(
    `https://app.altorank.co/api/auth/google/callback?code=c&state=${encodeOauthState(workspaceId, integrationId, nonce)}`,
  );
  request.cookies.set(OAUTH_STATE_COOKIE, nonce);
  return GET(request);
}

function granted(...scopes: string[]) {
  exchangeCode.mockResolvedValueOnce({
    access_token: "a",
    refresh_token: "r",
    expires_at: Date.now() + 3_600_000,
    scope: scopes.join(" "),
  });
}

const integrationRows = () =>
  db.tables.workspace_integrations.map((r) => ({ workspace_id: r.workspace_id, integration_id: r.integration_id, config: r.config }));

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.GOOGLE_REDIRECT_URI = "https://app.altorank.co/api/auth/google/callback";
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  requireAuth.mockReset();
  requireAuth.mockResolvedValue({ user: { id: "u1" }, accountId: "acc-1", role: "owner" });
  exchangeCode.mockReset();
  listGSCSites.mockReset();
  listGSCSites.mockResolvedValue([{ siteUrl: "sc-domain:acme.co", permissionLevel: "siteOwner" }]);
  listGA4Properties.mockReset();
  listGA4Properties.mockResolvedValue([{ name: "properties/42", propertyId: "42", displayName: "acme.co - GA4" }]);
  backfillAnalytics.mockReset();
  backfillAnalytics.mockResolvedValue({ days: 7, gsc: 3, ga4: 0, errors: [] });
  db = fakeSupabase({
    workspaces: [
      { id: WS, account_id: "acc-1", domain: "acme.co" },
      { id: WS_NO_PROPERTY, account_id: "acc-1", domain: "unlisted.io" },
      { id: OTHER_ACCOUNT_WS, account_id: "acc-2", domain: "acme.co" },
    ],
    workspace_integrations: [],
    account_integrations: [],
    // Sees every site on the account: may set the account's consent.
    account_members: [{ account_id: "acc-1", user_id: "u1", role: "owner", workspace_ids: null }],
  });
  serviceRefuses = false;
});

/** Make u1 a member who sees only these sites. */
function restrictTo(...workspaceIds: string[]) {
  db.tables.account_members[0].workspace_ids = workspaceIds;
}

describe("account-level connect (no site named)", () => {
  it("stores the consent, connects the site being set up, and lands on the picker", async () => {
    granted(GSC_SCOPE);
    const res = await callback("account", "gsc");

    expect(res.headers.get("location")).toBe("https://app.altorank.co/connect/google");
    expect(requireAuth).toHaveBeenCalledWith(undefined, {});
    expect(db.tables.account_integrations).toHaveLength(1);
    expect(db.tables.account_integrations[0]).toMatchObject({ account_id: "acc-1", provider: "google" });

    // The wizard's site is connected, with its property resolved, and only
    // Search Console: this consent did not grant Analytics.
    expect(integrationRows()).toEqual([
      { workspace_id: WS, integration_id: "gsc", config: { type: "gsc", gscSiteUrl: "sc-domain:acme.co" } },
    ]);
    expect(listGA4Properties).not.toHaveBeenCalled();
    // One site connected: it gets its last week now.
    expect(backfillAnalytics).toHaveBeenCalledWith(expect.anything(), WS, "gsc", 7);
  });

  it("never touches a site in another account, even one on the same domain", async () => {
    granted(GSC_SCOPE);
    await callback("account", "gsc");
    expect(db.tables.workspace_integrations.some((r) => r.workspace_id === OTHER_ACCOUNT_WS)).toBe(false);
  });

  it("leaves several sites to the nightly sync rather than backfilling each", async () => {
    granted(GSC_SCOPE);
    listGSCSites.mockResolvedValue([
      { siteUrl: "sc-domain:acme.co", permissionLevel: "siteOwner" },
      { siteUrl: "https://unlisted.io/", permissionLevel: "siteOwner" },
    ]);
    await callback("account", "gsc");
    expect(new Set(db.tables.workspace_integrations.map((r) => r.workspace_id))).toEqual(new Set([WS, WS_NO_PROPERTY]));
    expect(backfillAnalytics).not.toHaveBeenCalled();
  });

  it("stores the consent with the service role, since members may only read it", async () => {
    // asMember refuses this table's writes, as RLS does: a consent written
    // with the person's client would leave the table empty here and the
    // picker saying "No Google account is connected yet".
    granted(GSC_SCOPE);
    const res = await callback("account", "gsc");
    expect(res.headers.get("location")).toBe("https://app.altorank.co/connect/google");
    expect(db.tables.account_integrations).toEqual([
      expect.objectContaining({ account_id: "acc-1", provider: "google", tokens: { encrypted: expect.any(String) } }),
    ]);
  });

  it("says so when the consent cannot be stored, instead of landing on a page that says nothing is connected", async () => {
    serviceRefuses = true;
    granted(GSC_SCOPE);
    const res = await callback("account", "gsc");
    const location = decodeURIComponent(res.headers.get("location") ?? "");
    expect(location).toContain("/connect?error=");
    expect(location).toContain("could not be saved");
    expect(db.tables.account_integrations).toHaveLength(0);
  });

  it("refuses a member scoped to some sites before Google's code is spent, and keeps the account's consent", async () => {
    restrictTo(WS);
    db.tables.account_integrations.push({ account_id: "acc-1", provider: "google", tokens: { encrypted: "owner's" } });
    const res = await callback("account", "gsc");
    const location = decodeURIComponent(res.headers.get("location") ?? "");
    expect(location).toContain("/connect?error=");
    expect(location).toContain("needs access to every site");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(db.tables.account_integrations).toEqual([
      { account_id: "acc-1", provider: "google", tokens: { encrypted: "owner's" } },
    ]);
    expect(db.writes).toHaveLength(0);
  });

  it("stores nothing when Google's consent comes back without Search Console", async () => {
    granted();
    const res = await callback("account", "gsc");
    const location = decodeURIComponent(res.headers.get("location") ?? "");
    expect(location).toContain("/connect?error=");
    expect(location).toContain("allow access to Search Console when Google asks");
    // Google's screen has no checkbox for a single scope to leave ticked.
    expect(location).not.toMatch(/tick/i);
    expect(db.writes).toHaveLength(0);
  });
});

describe("site-level connect", () => {
  it("writes a Search Console row only, for a Search Console consent", async () => {
    granted(GSC_SCOPE);
    const res = await callback(WS, "gsc");

    expect(res.headers.get("location")).toContain(`/workspaces/${WS}?connected=gsc`);
    expect(db.tables.workspace_integrations.every((r) => r.integration_id === "gsc")).toBe(true);
    expect(db.tables.workspace_integrations.some((r) => r.workspace_id === WS)).toBe(true);
    expect(listGA4Properties).not.toHaveBeenCalled();
    expect(db.tables.account_integrations).toHaveLength(1);
  });

  it("writes both rows when the GA4 consent also carries Search Console (include_granted_scopes)", async () => {
    granted(GSC_SCOPE, GA4_SCOPE);
    const res = await callback(WS, "ga4");

    expect(res.headers.get("location")).toContain(`/workspaces/${WS}?connected=ga4`);
    const forSite = db.tables.workspace_integrations.filter((r) => r.workspace_id === WS).map((r) => r.integration_id);
    expect(new Set(forSite)).toEqual(new Set(["gsc", "ga4"]));
    expect(db.tables.workspace_integrations).toContainEqual(
      expect.objectContaining({ workspace_id: WS, integration_id: "ga4", config: { type: "ga4", ga4PropertyId: "42" } }),
    );
  });

  it("connects a scoped member's own site but leaves the account's consent alone", async () => {
    restrictTo(WS);
    db.tables.account_integrations.push({ account_id: "acc-1", provider: "google", tokens: { encrypted: "owner's" } });
    granted(GSC_SCOPE);
    const res = await callback(WS, "gsc");

    expect(res.headers.get("location")).toContain(`/workspaces/${WS}?connected=gsc`);
    expect(db.tables.workspace_integrations.some((r) => r.workspace_id === WS && r.integration_id === "gsc")).toBe(true);
    expect(db.tables.account_integrations).toEqual([
      { account_id: "acc-1", provider: "google", tokens: { encrypted: "owner's" } },
    ]);
  });

  it("still connects the site when the account consent cannot be stored", async () => {
    serviceRefuses = true;
    granted(GSC_SCOPE);
    const res = await callback(WS, "gsc");
    expect(res.headers.get("location")).toContain(`/workspaces/${WS}?connected=gsc`);
    expect(db.tables.workspace_integrations.some((r) => r.workspace_id === WS)).toBe(true);
  });

  it("does not let an Analytics-only consent replace the account's Search Console consent", async () => {
    granted(GA4_SCOPE);
    await callback(WS, "ga4");
    expect(db.tables.account_integrations).toHaveLength(0);
    expect(db.tables.workspace_integrations.every((r) => r.integration_id === "ga4")).toBe(true);
    expect(listGSCSites).not.toHaveBeenCalled();
  });

  it("refuses a GA4 connect whose consent came back without Analytics, and writes nothing", async () => {
    granted(GSC_SCOPE);
    const res = await callback(WS, "ga4");
    const location = decodeURIComponent(res.headers.get("location") ?? "");
    expect(location).toContain("/connect?error=");
    expect(location).toContain("allow access to Google Analytics when Google asks");
    expect(location).not.toMatch(/tick/i);
    expect(db.writes).toHaveLength(0);
  });
});
