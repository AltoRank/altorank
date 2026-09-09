import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Six drafts dispatched at once must not spend more than the plan includes.
 *
 * Onboarding fans the first week's keywords out as six parallel requests to
 * /api/internal/draft (lib/content/fan-out.ts). Each one runs the quota gate
 * in generateArticle, and the gate read the count *before* inserting its
 * row, holding nothing in between - so all six read "2 remaining", all six
 * passed, and all six wrote. Four model calls the account was never entitled
 * to, on an account most likely to be on the free allowance.
 *
 * The fix re-reads the count after the insert, including the new row, and a
 * request that finds itself past the limit deletes its own row and stops.
 * This pins the arithmetic with a shared in-memory table standing in for
 * `articles`, so the six calls really do interleave.
 */

const getQuota = vi.fn();
vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: (...args: unknown[]) => getQuota(...args),
  quotaExceededMessage: (q: { used: number; limit: number }) => `out of quota (${q.used}/${q.limit})`,
}));

import { generateArticle } from "../generate";

/** The rows in `articles` this month, shared by every client in a test. */
const rows = new Set<string>();
let nextId = 0;
/** Number of generation jobs opened, i.e. runs that reached the model. */
let jobsOpened = 0;

function tick() {
  return new Promise<void>((r) => setTimeout(r, 0));
}

/**
 * Enough client to reach the article insert, the recount and the job insert.
 * `generation_jobs` fails on purpose so the run stops right after it has
 * been counted as "reached the model", without pulling in the AI tree.
 */
function client() {
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
      status: "active",
      paused_until: null,
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
              single: async () => {
                await tick();
                const id = `a${++nextId}`;
                rows.add(id);
                return { data: { id }, error: null };
              },
            }),
          }),
          delete: () => ({
            eq: async (_col: string, id: string) => {
              rows.delete(id);
              return { error: null };
            },
          }),
        };
      }
      if (table === "generation_jobs") {
        return {
          insert: () => ({
            select: () => ({
              single: async () => {
                jobsOpened += 1;
                return { data: null, error: { message: "stop here" } };
              },
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

const LIMIT = 7; // FREE_DRAFTS

beforeEach(() => {
  rows.clear();
  nextId = 0;
  jobsOpened = 0;
  getQuota.mockReset();
  // The real getQuota counts this month's rows; this one counts the shared
  // table, after yielding once so the calls interleave the way six HTTP
  // requests against one database do.
  getQuota.mockImplementation(async () => {
    await tick();
    const used = rows.size;
    return { limit: LIMIT, used, remaining: Math.max(0, LIMIT - used), reason: "no-plan", plan: null };
  });
});

describe("generateArticle, six autonomous drafts racing for two remaining", () => {
  it("lets through at most what remains and refuses the rest before the model", async () => {
    // Five of the seven free drafts are already used.
    for (let i = 0; i < 5; i++) rows.add(`old${i}`);

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        generateArticle({
          supabase: client(),
          workspaceId: "ws1",
          keyword: `keyword ${i}`,
          autonomous: true,
          callerEmail: null,
        }).then(
          () => "ok",
          (e: Error) => e.message,
        ),
      ),
    );

    const refused = results.filter((r) => r.startsWith("out of quota"));
    // Nothing past the allowance was written: whatever survived the burst
    // fits in the limit, and every refused run took its own row back out.
    expect(rows.size).toBeLessThanOrEqual(LIMIT);
    expect(jobsOpened).toBeLessThanOrEqual(2);
    expect(refused.length).toBeGreaterThanOrEqual(4);
    expect(refused.length + jobsOpened).toBe(6);
  });

  it("does not recount, and never deletes, when the plan is unmetered", async () => {
    getQuota.mockResolvedValue({ limit: null, used: 0, remaining: null, reason: "operator", plan: null });
    await generateArticle({
      supabase: client(),
      workspaceId: "ws1",
      keyword: "keyword",
      autonomous: true,
      callerEmail: null,
    }).catch(() => undefined);
    expect(getQuota).toHaveBeenCalledTimes(1);
    // The run reached the job insert (which this client fails on purpose,
    // and whose failure path takes the row back out).
    expect(jobsOpened).toBe(1);
  });

  it("does not recount a person writing past the limit, who is billed the overage instead", async () => {
    getQuota.mockResolvedValue({ limit: 100, used: 100, remaining: 0, reason: "plan", plan: "growth" });
    await generateArticle({
      supabase: client(),
      workspaceId: "ws1",
      keyword: "keyword",
      autonomous: false,
      callerEmail: "owner@example.test",
    }).catch(() => undefined);
    expect(getQuota).toHaveBeenCalledTimes(1);
    // The run reached the job insert (which this client fails on purpose,
    // and whose failure path takes the row back out).
    expect(jobsOpened).toBe(1);
  });
});
