import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Two overlapping cron runs must not write the same article twice.
 *
 * cron/generate picks a keyword from the recommendation queue and then
 * creates the article. It holds nothing between those steps, so two
 * invocations that overlap read the same queue, pick the same term and both
 * write. Measured on 2026-09-06 against the local stack: two runs fired one
 * second apart produced two complete 1,700-word drafts of "blog post
 * checklist" for one workspace, inserted 13 ms apart - two model calls, two
 * quota decrements, two "your draft is ready" emails, and two near-identical
 * articles in the client's review queue.
 *
 * Migration 074 closes the window with a partial unique index, which is the
 * only place that can: it is one INSERT wide. This pins the application half
 * - that a unique violation on that insert is read as "somebody else has
 * this one" and not as a generic insert failure, because the cron reports
 * the two differently and an operator should not be paged for the first.
 */

const getQuota = vi.fn();
vi.mock("@/lib/billing/quota", () => ({
  getQuota: (...args: unknown[]) => getQuota(...args),
  quotaExceededMessage: () => "out of quota",
}));

// See generate-quota-caller.test.ts: generate.ts pulls in the AI, SEO and
// billing tree, and transforming that inside a test's 5s budget times out.
// At module level the cost lands on collection, which has no such clock.
import { generateArticle, ConcurrentGenerationError } from "../generate";

/**
 * Enough client to reach the article insert and no further.
 *
 * The insert is the last thing this test cares about; everything before it
 * (workspace, voice profile, output settings, keyword row) returns the empty
 * answer that a bare workspace gives.
 */
function client(insertError: { code?: string; message: string } | null) {
  const single = async () => ({
    data: {
      id: "ws1",
      account_id: "agency1",
      domain: "example.test",
      ai_provider: null,
      ai_model: null,
      language: null,
      brand_style: null,
      location_code: null,
    },
    error: null,
  });
  const empty = async () => ({ data: null, error: null });

  return {
    from: (table: string) => {
      if (table === "articles") {
        return {
          insert: () => ({
            select: () => ({
              single: async () =>
                insertError
                  ? { data: null, error: insertError }
                  : { data: { id: "a1" }, error: null },
            }),
          }),
        };
      }
      const chain: Record<string, unknown> = {
        eq: () => chain,
        ilike: () => chain,
        limit: () => chain,
        single,
        maybeSingle: empty,
      };
      return { select: () => chain };
    },
  } as never;
}

beforeEach(() => {
  getQuota.mockReset();
  getQuota.mockResolvedValue({ limit: null, used: 0, remaining: null, reason: "paid", plan: "pro" });
});

describe("generateArticle, two runs racing for one keyword", () => {
  const opts = {
    workspaceId: "ws1",
    keyword: "blog post checklist",
    autonomous: true,
    callerEmail: null,
  };

  it("reads a unique violation on the insert as the other run winning", async () => {
    const err = await generateArticle({
      ...opts,
      supabase: client({ code: "23505", message: "duplicate key value violates unique constraint" }),
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ConcurrentGenerationError);
    expect(err.keyword).toBe("blog post checklist");
    expect(err.workspaceId).toBe("ws1");
    // The cron puts this in front of a human, so it has to read as a
    // non-event rather than as a database error.
    expect(err.message).toContain("already being written by another run");
  });

  it("still reports a real insert failure as one", async () => {
    // Anything that is not 23505 is a genuine failure and must not be
    // laundered into "another run has it", which would make the cron report
    // a skip and quietly write nothing, every run, for ever.
    const err = await generateArticle({
      ...opts,
      supabase: client({ code: "23502", message: "null value in column \"slug\"" }),
    }).catch((e) => e);

    expect(err).not.toBeInstanceOf(ConcurrentGenerationError);
    expect(err.message).toContain("Failed to create article");
  });
});

vi.mock("@/lib/keyword-research/opportunity", () => ({ assertAutonomousTopic: async () => ({status:"qualified",audience:"buyer",buyingJob:"job",offering:"offering",angle:"angle",reason:"reason"}) }));
