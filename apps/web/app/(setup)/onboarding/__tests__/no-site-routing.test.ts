// Where a signed-in account with no site is sent. It used to be the empty
// Sites table, from /onboarding, and a dashboard of dashes, from /dashboard
// (where signing in lands). A real signup reached both on 2026-10-19 and never
// added a site. Now both send it to /onboarding/site, and that page asks for
// the domain only of someone who can add a site: anyone else goes to the Sites
// page, which says who can.

import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT:${to}`);
});
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to), notFound: vi.fn() }));

let scope: string | null = null;
vi.mock("@/lib/workspace-scope", () => ({
  SCOPE_COOKIE: "active_workspace",
  getScopedWorkspaceId: async () => scope,
  getScope: async () => (scope ? { workspaceId: scope, accountId: "account-1" } : null),
  openSitesOutside: async () => [],
}));

let member: { role: string; workspace_ids: string[] | null } | null = { role: "owner", workspace_ids: null };
const memberRead = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "owner@acme.example", user_metadata: {} } } }) },
    from: (table: string) => {
      memberRead(table);
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: member, error: null }) };
      return chain;
    },
  }),
  createServiceClient: () => ({}),
}));
vi.mock("@/lib/queries/account", () => ({ workingAccountId: async () => "account-1" }));
// The page imports the sign-out and add-site actions only to hand them to its
// forms; neither runs here.
vi.mock("@/app/actions/auth", () => ({ signOut: vi.fn() }));
vi.mock("@/app/actions/first-site", () => ({ addFirstSite: vi.fn() }));
// The wizard and the gate's readers are never reached with no site, and
// importing them is most of a cold import of /onboarding.
vi.mock("@/components/onboarding/wizard", () => ({ OnboardingWizard: () => null }));
vi.mock("@/components/onboarding/track-step", () => ({ TrackStep: () => null }));
vi.mock("@/lib/onboarding/first-look-report", () => ({ loadFirstLookReport: vi.fn() }));
vi.mock("@/lib/onboarding/first-article", () => ({ loadFirstArticle: vi.fn() }));
vi.mock("@/lib/onboarding/first-article-body", () => ({ fullArticleOn: vi.fn(), readFirstArticleBody: vi.fn() }));

async function firstSitePage(searchParams: Record<string, string> = {}) {
  const { default: Page } = await import("../site/page");
  return Page({ searchParams: Promise.resolve(searchParams) });
}

async function landing(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const message = (e as Error).message;
    if (!message.startsWith("NEXT_REDIRECT:")) throw e;
    return message.replace("NEXT_REDIRECT:", "");
  }
}

beforeEach(() => {
  scope = null;
  member = { role: "owner", workspace_ids: null };
  memberRead.mockClear();
  redirect.mockClear();
});

describe("/onboarding with no site", () => {
  it("asks for the domain instead of opening the Sites table", async () => {
    const { default: OnboardingPage } = await import("../page");
    expect(await landing(() => OnboardingPage({ searchParams: Promise.resolve({}) }))).toBe("/onboarding/site");
  }, 20_000);
});

describe("/onboarding/site", () => {
  it("shows the domain question to an owner with no site", async () => {
    expect(await landing(() => firstSitePage())).toBeNull();
  });

  it("sends someone who already has a site to the wizard, reading nothing else", async () => {
    scope = "ws-1";
    expect(await landing(() => firstSitePage())).toBe("/onboarding");
    expect(memberRead).not.toHaveBeenCalled();
  });

  it("sends an editor, who cannot add a site, to the Sites page", async () => {
    member = { role: "editor", workspace_ids: null };
    expect(await landing(() => firstSitePage())).toBe("/workspaces");
  });

  it("sends an admin limited to some sites to the Sites page", async () => {
    member = { role: "admin", workspace_ids: ["ws-elsewhere"] };
    expect(await landing(() => firstSitePage())).toBe("/workspaces");
  });
});
