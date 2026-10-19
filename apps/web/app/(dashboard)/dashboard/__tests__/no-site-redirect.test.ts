// Signing in lands on /dashboard. With no site, every section here is about
// nothing, and an account in that state (a real signup, 2026-10-19) saw a
// dashboard of dashes and never added a site. It is sent to name one before
// anything on this page is read.

import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT:${to}`);
});
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to), notFound: vi.fn() }));
vi.mock("@/lib/workspace-scope", () => ({ getScopedWorkspaceId: async () => null }));
const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient(), createServiceClient: vi.fn() }));

describe("/dashboard with no site", () => {
  it("sends the account to name its site, reading nothing", async () => {
    const { default: DashboardPage } = await import("../page");
    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT:/onboarding/site");
    expect(createClient).not.toHaveBeenCalled();
  }, 30_000);
});
