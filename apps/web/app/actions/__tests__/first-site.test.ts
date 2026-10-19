// An account with no site names one on /onboarding/site and goes straight to
// the wizard. A real signup (2026-10-19) got an account with no site, was
// sent to the empty Sites table twice, and never added one. The site this
// writes has to be the one signup writes - opted into the free drafts, with
// automatic approval off - and every refusal has to come back to the form as
// a sentence, the domain kept.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FREE_TIER_PACE } from "@/lib/content/pace";

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT:${to}`);
});
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));

const cookieSet = vi.fn();
vi.mock("next/headers", () => ({ cookies: async () => ({ set: cookieSet }) }));

let user: { id: string; email: string } | null = { id: "u1", email: "owner@acme.example" };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
  createServiceClient: () => ({ service: true }),
}));

let scope: string | null = null;
vi.mock("@/lib/workspace-scope", () => ({
  SCOPE_COOKIE: "active_workspace",
  getScopedWorkspaceId: async () => scope,
}));
vi.mock("@/lib/queries/account", () => ({ workingAccountId: async () => "account-1" }));

let reach: { ok: true } | { ok: false; reason: string } = { ok: true };
vi.mock("@/lib/domain/reachable", () => ({ checkDomainReachable: async () => reach }));

type Allowance = import("@/lib/billing/workspaces").WorkspaceAllowance;
let allowance: Allowance = { limit: 1, used: 0, remaining: 1, reason: "no-plan", plan: null };
vi.mock("@/lib/billing/workspaces", async () => {
  const real = await vi.importActual<typeof import("@/lib/billing/workspaces")>("@/lib/billing/workspaces");
  return { ...real, getWorkspaceAllowance: async () => allowance };
});

const insert = vi.fn();
let insertResult: { ok: true; id: string } | { ok: false; error: string } = { ok: true, id: "ws-new" };
vi.mock("@/lib/workspaces/insert", () => ({
  insertWorkspaceAsServer: async (...args: unknown[]) => {
    insert(...args);
    return insertResult;
  },
}));
vi.mock("@/lib/seo/indexing", () => ({ generateIndexNowKey: () => "key" }));

const step = vi.fn();
vi.mock("@/lib/onboarding/step-events", () => ({ recordOnboardingStep: async (...args: unknown[]) => step(...args) }));

function form(domain: string) {
  const fd = new FormData();
  fd.set("domain", domain);
  return fd;
}

async function submit(domain: string): Promise<string> {
  const { addFirstSite } = await import("../first-site");
  try {
    await addFirstSite(form(domain));
  } catch (e) {
    return (e as Error).message.replace("NEXT_REDIRECT:", "");
  }
  throw new Error("addFirstSite returned without redirecting");
}

/** The error a back-redirect carries, and the domain it kept. */
function backTo(to: string) {
  const url = new URL(to, "https://app.example");
  return { path: url.pathname, error: url.searchParams.get("error"), domain: url.searchParams.get("domain") };
}

beforeEach(() => {
  user = { id: "u1", email: "owner@acme.example" };
  scope = null;
  reach = { ok: true };
  allowance = { limit: 1, used: 0, remaining: 1, reason: "no-plan", plan: null };
  insertResult = { ok: true, id: "ws-new" };
  insert.mockClear();
  step.mockClear();
  cookieSet.mockClear();
  redirect.mockClear();
});

describe("addFirstSite", () => {
  it("writes the signup site, records the step, scopes to it and opens the wizard", async () => {
    expect(await submit("https://WWW.Acme.com/blog")).toBe("/onboarding");

    expect(insert).toHaveBeenCalledTimes(1);
    const [, userId, accountId, row] = insert.mock.calls[0] as [unknown, string, string, Record<string, unknown>];
    expect(userId).toBe("u1");
    expect(accountId).toBe("account-1");
    expect(row).toMatchObject({
      name: "acme.com",
      domain: "acme.com",
      auto_generate: true,
      auto_generate_weekly_limit: FREE_TIER_PACE,
    });
    expect(row).not.toHaveProperty("auto_approve");

    expect(step).toHaveBeenCalledWith(
      { service: true },
      { workspaceId: "ws-new", accountId: "account-1", userId: "u1", step: "site_added" },
    );
    expect(cookieSet).toHaveBeenCalledWith("active_workspace", "ws-new", expect.objectContaining({ path: "/" }));
  });

  it("sends someone who already has a site to the wizard without writing another", async () => {
    scope = "ws-existing";
    expect(await submit("acme.com")).toBe("/onboarding");
    expect(insert).not.toHaveBeenCalled();
  });

  it("asks again for something that is not a domain", async () => {
    const back = backTo(await submit("not a domain"));
    expect(back.path).toBe("/onboarding/site");
    expect(back.error).toBe("Enter your website as a domain, like acme.com.");
    expect(insert).not.toHaveBeenCalled();
  });

  it("says why a domain with no DNS is refused, and keeps it in the field", async () => {
    reach = { ok: false, reason: "acme-typo.com does not resolve. Check the spelling." };
    const back = backTo(await submit("acme-typo.com"));
    expect(back.error).toBe("acme-typo.com does not resolve. Check the spelling.");
    expect(back.domain).toBe("acme-typo.com");
    expect(insert).not.toHaveBeenCalled();
  });

  it("holds the site allowance like every other way to add a site", async () => {
    allowance = { limit: 1, used: 1, remaining: 0, reason: "no-plan", plan: null };
    const back = backTo(await submit("acme.com"));
    expect(back.error).toMatch(/One workspace is included before choosing a plan/);
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns the insert's refusal (role, pause) to the form instead of throwing it", async () => {
    insertResult = { ok: false, error: "Adding a workspace changes what the account pays for, so an owner or admin has to do it." };
    const back = backTo(await submit("acme.com"));
    expect(back.error).toMatch(/an owner or admin has to do it/);
    expect(step).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("sends a signed-out visitor to sign in and back", async () => {
    user = null;
    expect(await submit("acme.com")).toBe("/signin?next=%2Fonboarding%2Fsite");
    expect(insert).not.toHaveBeenCalled();
  });
});
