import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The setup checklist counts the site the sidebar is scoped to, not the
 * account. Until 2026-09-07 an agency's second client showed "CMS connected"
 * and "voice trained" on the day it was added, because the first client had
 * done both.
 */
let scope: string | null = "ws-2";
const filters: Record<string, [string, unknown][]> = {};

vi.mock("@/lib/workspace-scope", () => ({ getScopedWorkspaceId: async () => scope }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      filters[table] = [];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters[table].push([col, val]);
          return q;
        },
        then: (resolve: (v: { count: number }) => void) => resolve({ count: 1 }),
      };
      return q;
    },
  }),
}));

beforeEach(() => {
  for (const k of Object.keys(filters)) delete filters[k];
});

describe("getCompletedOnboardingSteps", () => {
  it("narrows every per-site table to the scoped workspace, and never the workspace list", async () => {
    scope = "ws-2";
    const { getCompletedOnboardingSteps } = await import("../onboarding");
    await getCompletedOnboardingSteps();
    for (const table of ["keywords", "articles", "workspace_integrations", "voice_profiles"]) {
      expect(filters[table], table).toContainEqual(["workspace_id", "ws-2"]);
    }
    expect(filters.voice_profiles).toContainEqual(["trained", true]);
    expect(filters.workspaces).toEqual([]);
  });

  it("counts the account when no site is scoped", async () => {
    scope = null;
    const { getCompletedOnboardingSteps } = await import("../onboarding");
    await getCompletedOnboardingSteps();
    for (const table of ["keywords", "articles", "workspace_integrations", "voice_profiles"]) {
      expect(filters[table].some(([c]) => c === "workspace_id"), table).toBe(false);
    }
  });
});
