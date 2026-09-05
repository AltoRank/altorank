import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The guards around "Write now". The writer itself is mocked: what is pinned
 * here is that the action refuses before spending anything when the entry is
 * already written or already being written, that a quota refusal from the
 * writer reaches the person with its own words and leaves the entry unlinked,
 * and that a successful run links the entry and never publishes.
 */

const generateArticle = vi.fn();
vi.mock("@/lib/content/generate", () => ({
  generateArticle: (...args: unknown[]) => generateArticle(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/workspace-scope", () => ({ getScopedWorkspaceId: async () => "ws1" }));

const fulfil = vi.fn();
vi.mock("@/lib/onboarding/plan", () => ({
  fulfilPlannedEntry: (...args: unknown[]) => fulfil(...args),
  countScheduled: async () => 0,
  ensureQuestionsFor: async () => 0,
  schedulePlan: async () => [],
  PLAN_MAX_ENTRIES: 60,
}));

/** What the tables hold for this test. */
const db: { entry: Record<string, unknown> | null; drafting: Record<string, unknown> | null } = { entry: null, drafting: null };
const updates: Array<{ table: string; patch: unknown }> = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { email: "owner@example.com" } } }) },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain, eq: chain, is: chain, in: chain, order: chain, limit: chain, ilike: chain,
        update: (patch: unknown) => { updates.push({ table, patch }); return q; },
        maybeSingle: async () => ({
          data: table === "calendar_entries" ? db.entry : table === "articles" ? db.drafting : null,
          error: null,
        }),
        then: (r: (v: { data: unknown; error: null }) => unknown) => r({ data: [], error: null }),
      });
      return q;
    },
  }),
}));

beforeEach(() => {
  generateArticle.mockReset();
  fulfil.mockReset();
  updates.length = 0;
  db.entry = { id: "e1", keyword_id: "k1", keyword: "seo content", article_id: null };
  db.drafting = null;
});

describe("writeNow", () => {
  it("refuses an entry that is not on this workspace's plan", async () => {
    db.entry = null;
    const { writeNow } = await import("@/app/actions/plan");
    await expect(writeNow("e1")).rejects.toThrow(/not on the plan/);
    expect(generateArticle).not.toHaveBeenCalled();
  });

  it("refuses an entry that already has an article", async () => {
    db.entry = { ...db.entry!, article_id: "a9" };
    const { writeNow } = await import("@/app/actions/plan");
    await expect(writeNow("e1")).rejects.toThrow(/already been written/);
    expect(generateArticle).not.toHaveBeenCalled();
  });

  it("refuses while a draft for the keyword is already being written", async () => {
    db.drafting = { id: "a-inflight" };
    const { writeNow } = await import("@/app/actions/plan");
    await expect(writeNow("e1")).rejects.toThrow(/already being written/);
    expect(generateArticle).not.toHaveBeenCalled();
  });

  it("surfaces the writer's quota refusal and leaves the entry unlinked", async () => {
    generateArticle.mockRejectedValue(new Error("The free draft is used. Choose a plan on the Billing page to keep going."));
    const { writeNow } = await import("@/app/actions/plan");
    await expect(writeNow("e1")).rejects.toThrow(/free draft is used/);
    expect(fulfil).not.toHaveBeenCalled();
    expect(updates.filter((u) => u.table === "calendar_entries")).toHaveLength(0);
  });

  it("writes as the signed-in person, not autonomously, and links the entry on success", async () => {
    generateArticle.mockResolvedValue({ articleId: "a1", jobId: "j1", title: "T", wordCount: 900 });
    const { writeNow } = await import("@/app/actions/plan");
    await expect(writeNow("e1")).resolves.toEqual({ articleId: "a1" });

    const opts = generateArticle.mock.calls[0][0];
    expect(opts).toMatchObject({ workspaceId: "ws1", keyword: "seo content", keywordId: "k1", autonomous: false, callerEmail: "owner@example.com" });
    expect(fulfil).toHaveBeenCalledWith(expect.anything(), "e1", "a1");
  });

  it("never touches an article's status itself: review is the writer's destination", async () => {
    generateArticle.mockResolvedValue({ articleId: "a1", jobId: "j1", title: "T", wordCount: 900 });
    const { writeNow } = await import("@/app/actions/plan");
    await writeNow("e1");
    expect(updates.filter((u) => u.table === "articles")).toHaveLength(0);
  });
});
