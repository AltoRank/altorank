import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import { decodeOauthState, OAUTH_STATE_COOKIE } from "@/lib/google/oauth-state";
import { GA4_SCOPE, GSC_SCOPE } from "@/lib/google/oauth";

// ---------------------------------------------------------------------------
// GET /api/auth/google: the start of every Google connection
// ---------------------------------------------------------------------------
//
// Every "Connect Search Console" that is not a site's own button (the
// onboarding wizard, /connect/google, Settings) arrives here with no
// workspaceId. The route looked the site up anyway, as `id = null`, and sent
// every one of them back with `workspace_not_found` (broken since 2026-09-02).

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";

const requireAuth = vi.fn();
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: (...args: unknown[]) => requireAuth(...args) }));

let db: FakeSupabase;
let tablesRead: string[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      tablesRead.push(table);
      return db.from(table);
    },
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
  }),
}));

const { GET } = await import("../route");

function get(query: string) {
  return GET(new NextRequest(`https://app.altorank.co/api/auth/google?${query}`));
}

/** The Google consent URL the route redirected to, with its state decoded. */
function consent(res: Response) {
  const location = res.headers.get("location") ?? "";
  const url = new URL(location);
  return {
    url,
    scopes: (url.searchParams.get("scope") ?? "").split(" "),
    state: decodeOauthState(url.searchParams.get("state")),
  };
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.GOOGLE_REDIRECT_URI = "https://app.altorank.co/api/auth/google/callback";
  requireAuth.mockReset();
  tablesRead = [];
  requireAuth.mockResolvedValue({ user: { id: "u1" }, accountId: "acc-1", role: "owner" });
  db = fakeSupabase({
    workspaces: [
      { id: WS, account_id: "acc-1", domain: "acme.co" },
      { id: OTHER_WS, account_id: "acc-2", domain: "rival.co" },
    ],
  });
});

describe("GET /api/auth/google with no workspaceId (account level)", () => {
  it("goes to Google with `account` in the state, not workspace_not_found", async () => {
    const res = await get("integrationId=gsc");
    expect(res.status).toBe(307);
    const { url, state } = consent(res);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(state).toMatchObject({ workspaceId: "account", integrationId: "gsc" });
    // The nonce in the state is the one this browser keeps.
    expect(res.headers.get("set-cookie")).toContain(`${OAUTH_STATE_COOKIE}=${state?.nonce}`);
  });

  it("asks requireAuth for the account in scope and never looks a site up", async () => {
    await get("integrationId=gsc");
    expect(requireAuth).toHaveBeenCalledWith(undefined, {});
    expect(tablesRead).not.toContain("workspaces");
    expect(db.writes).toHaveLength(0);
  });

  it("treats an empty workspaceId as none", async () => {
    const res = await get("workspaceId=&integrationId=gsc");
    expect(consent(res).state).toMatchObject({ workspaceId: "account", integrationId: "gsc" });
  });

  it("says no_account when the person belongs to no account", async () => {
    requireAuth.mockRejectedValueOnce(new Error("No account membership found"));
    const res = await get("integrationId=gsc");
    expect(res.headers.get("location")).toBe("https://app.altorank.co/connect?error=no_account");
  });

  it("does not connect Analytics without a site: a GA4 property belongs to one", async () => {
    const res = await get("integrationId=ga4");
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://app.altorank.co/connect?error=")).toBe(true);
    expect(location).not.toContain("accounts.google.com");
    expect(requireAuth).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/google with a workspaceId", () => {
  it("puts the site in the state once the account owns it", async () => {
    const res = await get(`workspaceId=${WS}&integrationId=gsc`);
    expect(requireAuth).toHaveBeenCalledWith(undefined, { workspaceId: WS });
    expect(consent(res).state).toMatchObject({ workspaceId: WS, integrationId: "gsc" });
  });

  it("refuses a site in another account", async () => {
    const res = await get(`workspaceId=${OTHER_WS}&integrationId=gsc`);
    expect(res.headers.get("location")).toBe("https://app.altorank.co/connect?error=workspace_not_found");
  });

  it("refuses a site requireAuth cannot place", async () => {
    requireAuth.mockRejectedValueOnce(new Error("Workspace not found"));
    const res = await get(`workspaceId=${WS}&integrationId=gsc`);
    expect(res.headers.get("location")).toBe("https://app.altorank.co/connect?error=workspace_not_found");
  });
});

describe("the scopes each entry point asks Google for", () => {
  it("Search Console asks for Search Console only, from the account or a site", async () => {
    for (const query of ["integrationId=gsc", `workspaceId=${WS}&integrationId=gsc`]) {
      const { scopes, url } = consent(await get(query));
      expect(scopes).toEqual([GSC_SCOPE]);
      expect(scopes).not.toContain(GA4_SCOPE);
      expect(url.searchParams.get("include_granted_scopes")).toBe("true");
      expect(url.searchParams.get("access_type")).toBe("offline");
    }
  });

  it("Google Analytics asks for Analytics only, and keeps what was granted before", async () => {
    const { scopes, url, state } = consent(await get(`workspaceId=${WS}&integrationId=ga4`));
    expect(scopes).toEqual([GA4_SCOPE]);
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(state).toMatchObject({ workspaceId: WS, integrationId: "ga4" });
  });

  it("refuses an integration Google does not back", async () => {
    const res = await get(`workspaceId=${WS}&integrationId=bing`);
    expect(res.headers.get("location")).toContain("error=unsupported_integration");
  });
});
