/**
 * Which site - and so which account - a person in two accounts is working in.
 *
 * Round-4 review: someone invited to a paying account who also owns an older,
 * never-trialed one landed, with no scope cookie yet (an invitation sets
 * none), on their own oldest site. The dashboard gated it and sent them to its
 * trial card, which had no way to the paying account: the account they were
 * invited to work in was unreachable without paying for the one they were not
 * using. And every server action asked the trial gate about the oldest
 * MEMBERSHIP while the dashboard answered for the oldest SITE.
 *
 * The real chain runs here - getScope -> sessionTrialGate -> getRequestQuota
 * -> getQuota -> trialGateState, and requireAuth on top of it. Only the
 * database and the cookie jar are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.STRIPE_SECRET_KEY = "sk_test_workspace_scope_gate";
delete process.env.TRIAL_GATE_DISABLED;
delete process.env.TRIAL_GATE_BYPASS_EMAILS;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

type Row = Record<string, unknown>;

const MEMBER = "member@acme-agency.example";
let cookie: string | undefined;
let tables: Record<string, Row[]> = {};
let accountReads = 0;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "active_workspace" && cookie ? { value: cookie } : undefined),
  }),
}));

/** A PostgREST stand-in that applies the filters these reads use. */
function fakeClient() {
  const from = (table: string) => {
    if (table === "accounts") accountReads += 1;
    let rows = [...(tables[table] ?? [])];
    let head = false;
    const q: Record<string, unknown> = {};
    Object.assign(q, {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        head = Boolean(opts?.head);
        return q;
      },
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val);
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        rows = rows.filter((r) => vals.includes(r[col]));
        return q;
      },
      neq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] !== val);
        return q;
      },
      gte: () => q,
      is: () => q,
      limit: () => q,
      // Rows are listed oldest first below, which is the order asked for.
      order: () => q,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => (rows[0] ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116", message: "0 rows" } }),
      then: (resolve: (v: unknown) => unknown) =>
        resolve(head ? { data: null, count: rows.length, error: null } : { data: rows, count: rows.length, error: null }),
    });
    return q;
  };
  return {
    from,
    auth: {
      getUser: async () => ({ data: { user: { id: "u-member", email: MEMBER } }, error: null }),
      admin: { getUserById: async () => ({ data: { user: { email: "owner@client.example" } }, error: null }) },
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fakeClient(),
  createServiceClient: () => fakeClient(),
}));

const { getScope, getScopedWorkspaceId, openSitesOutside } = await import("@/lib/workspace-scope");
const { requireAuth } = await import("@/lib/auth/require-auth");

/** Never trialed, no plan, first article written: the gate holds it. */
const GATED = { id: "acct-own", plan: "starter", plan_status: "inactive", trial_ends_at: null, stripe_subscription_id: null, free_drafts_used: 1, created_by: "u-member" };
/** A paying team the person was invited to. */
const PAYING = { id: "acct-team", plan: "growth", plan_status: "active", trial_ends_at: null, stripe_subscription_id: "sub_team", free_drafts_used: 0, created_by: "u-owner" };

function seed(opts: { payingPlanStatus?: string } = {}) {
  tables = {
    // The person's own site is the OLDER one: the case the old fallback got wrong.
    workspaces: [
      { id: "site-own", account_id: GATED.id, name: "Own site", domain: "own-site.example" },
      { id: "site-team", account_id: PAYING.id, name: "Team site", domain: "team-site.example" },
    ],
    accounts: [GATED, { ...PAYING, plan_status: opts.payingPlanStatus ?? PAYING.plan_status }],
    articles: [{ id: "first", workspace_id: "site-own", status: "review" }],
    account_members: [
      { account_id: GATED.id, user_id: "u-member", role: "owner", created_at: "2026-09-01T00:00:00Z" },
      { account_id: PAYING.id, user_id: "u-member", role: "editor", created_at: "2026-09-10T00:00:00Z" },
    ],
  };
}

beforeEach(async () => {
  cookie = undefined;
  accountReads = 0;
  seed();
  const { clearOperatorAccountCache } = await import("@/lib/billing/operator-account");
  clearOperatorAccountCache();
});

describe("the scope for a person in a paying account and a gated one", () => {
  it("opens on the paying account's site when nothing names one", async () => {
    expect(await getScopedWorkspaceId()).toBe("site-team");
    expect(await getScope()).toEqual({ workspaceId: "site-team", accountId: PAYING.id });
  });

  it("makes every action answer for that same account", async () => {
    // Oldest membership is the gated one; the scope wins.
    expect(await requireAuth()).toMatchObject({ accountId: PAYING.id, role: "editor" });
  });

  it("keeps a site the person chose, even their gated one", async () => {
    cookie = "site-own";
    expect(await getScope()).toEqual({ workspaceId: "site-own", accountId: GATED.id });
    expect(await requireAuth()).toMatchObject({ accountId: GATED.id, role: "owner" });
  });

  it("offers the paying account's site on the gated site's card", async () => {
    expect(await openSitesOutside(GATED.id)).toEqual([{ id: "site-team", label: "team-site.example" }]);
  });

  it("offers nothing when the other account is gated too, and opens on the oldest site", async () => {
    seed({ payingPlanStatus: "inactive" });
    tables.accounts[1] = { ...tables.accounts[1], stripe_subscription_id: null };
    expect(await openSitesOutside(GATED.id)).toEqual([]);
    expect(await getScopedWorkspaceId()).toBe("site-own");
  });

  it("does not ask the gate at all for a person in one account", async () => {
    tables.workspaces = tables.workspaces.filter((w) => w.account_id === GATED.id);
    expect(await getScopedWorkspaceId()).toBe("site-own");
    expect(accountReads).toBe(0);
  });
});
