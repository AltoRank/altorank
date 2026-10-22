import { describe, it, expect, vi, beforeEach } from "vitest";

const generate = vi.fn();
const events: Array<{ message: string; context?: Record<string, unknown> | null }> = [];
vi.mock("@/lib/content/generate", () => ({ generateArticle: (...a: unknown[]) => generate(...a) }));
vi.mock("@/lib/observability/record", () => ({
  recordEvent: async (e: { message: string; context?: Record<string, unknown> | null }) => {
    events.push(e);
    return true;
  },
}));

import { notRegenerableReason, regenerateDraft, type RegenerableRow } from "../regenerate-draft";

const open: RegenerableRow = { status: "review", approved_at: null, published_url: null, published_at: null, external_id: null, scheduled_at: null };

const ARTICLE = {
  id: "a1",
  workspace_id: "ws1",
  keyword: "soothing cream for diaper rash",
  keyword_id: "k1",
  title: "Soothing cream for diaper rash",
  word_count: 1082,
  fact_check_verdict: "clean",
  generated_autonomously: true,
  selection_reasons: ["320 searches/mo"],
  selection_score: 18.8,
  keyword_difficulty: 22,
  volume: 320,
  ...open,
};

function db(article: Record<string, unknown> | null) {
  const chain = (data: unknown) => {
    const c = { select: () => c, eq: () => c, maybeSingle: async () => ({ data, error: null }) };
    return c;
  };
  return { from: (t: string) => (t === "articles" ? chain(article) : chain({ account_id: "acct1" })) } as never;
}

beforeEach(() => {
  generate.mockReset();
  events.length = 0;
  generate.mockResolvedValue({ title: "New title", wordCount: 950, factCheck: { verdict: "clean" }, seoScore: 90, aeoScore: 88 });
});

describe("notRegenerableReason", () => {
  it("allows a draft nobody has acted on", () => {
    expect(notRegenerableReason(open)).toBeNull();
    expect(notRegenerableReason({ ...open, status: "draft" })).toBeNull();
  });

  it("refuses anything accepted, scheduled, live or in flight", () => {
    expect(notRegenerableReason({ ...open, published_url: "https://x.example/p" })).toMatch(/published/);
    expect(notRegenerableReason({ ...open, status: "live" })).toMatch(/published/);
    expect(notRegenerableReason({ ...open, external_id: "123" })).toMatch(/CMS/);
    expect(notRegenerableReason({ ...open, approved_at: "2026-10-22T00:00:00Z" })).toMatch(/approved/);
    expect(notRegenerableReason({ ...open, status: "scheduled" })).toMatch(/scheduled/);
    expect(notRegenerableReason({ ...open, status: "drafting" })).toMatch(/being written/);
    expect(notRegenerableReason({ ...open, status: "archived" })).toMatch(/archived/);
  });
});

describe("regenerateDraft", () => {
  it("rewrites into the same row, as the operator, keeping why it was chosen", async () => {
    await regenerateDraft(db(ARTICLE), "a1", "ops@example.com");
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        articleId: "a1",
        keyword: "soothing cream for diaper rash",
        keywordId: "k1",
        autonomous: true,
        callerEmail: "ops@example.com",
        selection: { reasons: ["320 searches/mo"], score: 18.8, difficulty: 22, volume: 320 },
      }),
    );
  });

  it("records what was replaced and what replaced it", async () => {
    await regenerateDraft(db(ARTICLE), "a1", "ops@example.com");
    expect(events).toHaveLength(2);
    expect(events[1].context).toMatchObject({
      before: { title: "Soothing cream for diaper rash", wordCount: 1082, verdict: "clean" },
      after: { title: "New title", wordCount: 950, verdict: "clean" },
    });
  });

  it("refuses a published draft before spending anything", async () => {
    await expect(regenerateDraft(db({ ...ARTICLE, published_url: "https://x.example/p" }), "a1", "ops@example.com")).rejects.toThrow(/published/);
    expect(generate).not.toHaveBeenCalled();
  });

  it("says so when the article does not exist", async () => {
    await expect(regenerateDraft(db(null), "nope", "ops@example.com")).rejects.toThrow(/no such article/);
  });
});
