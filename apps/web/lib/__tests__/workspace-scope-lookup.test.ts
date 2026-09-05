/**
 * `getScopedWorkspaceId` decides which site every dashboard page is about, so
 * it sits at the head of every render's critical path. It is one read of the
 * account's site ids, chosen in memory: a valid cookie wins, anything else -
 * missing, "all", a foreign id - falls back to the oldest site.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

let cookieValue: string | undefined;
let reads = 0;
const ids: string[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "active_workspace" && cookieValue ? { value: cookieValue } : undefined),
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      reads += 1;
      const q = {
        select: () => q,
        order: () => q,
        then: (r: (v: { data: unknown }) => unknown) => r({ data: ids.map((id) => ({ id })) }),
      };
      return q;
    },
  }),
}));

// React's `cache` needs a request scope to deduplicate; outside one it calls
// straight through, which is what these tests want.
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

beforeEach(() => {
  cookieValue = undefined;
  reads = 0;
  ids.length = 0;
  ids.push("oldest", "newer");
});

describe("getScopedWorkspaceId", () => {
  it("returns the cookie's site when it belongs to the account", async () => {
    cookieValue = "newer";
    expect(await getScopedWorkspaceId()).toBe("newer");
  });

  it("falls back to the oldest site for a foreign id", async () => {
    cookieValue = "someone-elses-site";
    expect(await getScopedWorkspaceId()).toBe("oldest");
  });

  it("treats the legacy 'all' as no choice", async () => {
    cookieValue = "all";
    expect(await getScopedWorkspaceId()).toBe("oldest");
  });

  it("returns null for an account with no sites", async () => {
    ids.length = 0;
    cookieValue = "anything";
    expect(await getScopedWorkspaceId()).toBeNull();
  });

  it("prefers an explicit id over the cookie", async () => {
    cookieValue = "oldest";
    expect(await getScopedWorkspaceId("newer")).toBe("newer");
  });

  it("makes exactly one database read, cookie or no cookie", async () => {
    await getScopedWorkspaceId();
    expect(reads).toBe(1);
    reads = 0;
    cookieValue = "not-mine";
    await getScopedWorkspaceId();
    expect(reads).toBe(1);
  });
});
