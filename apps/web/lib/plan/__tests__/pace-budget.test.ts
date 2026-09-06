import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describePaceBudget, readPaceBudget, sharePaceBudget } from "../pace-budget";

/**
 * One weekly budget for drafts and rewrites. What is pinned: a rewrite spends
 * an article's slot, an improvement still due this week is held back from
 * the article side, nothing is counted twice, every read is scoped to the
 * workspace, and both crons read the same function rather than each keeping
 * its own count.
 */

describe("sharePaceBudget", () => {
  it("a rewrite spends one of the week's articles", () => {
    const b = sharePaceBudget({ weeklyLimit: 7, articlesWritten: 5, rewritesDone: 2, tasksPending: 0, refreshDays: 2 });
    expect(b).toMatchObject({ limit: 7, used: 7, articlesLeft: 0, improvementsLeft: 0 });
  });

  it("holds an improvement still due this week back from the article side", () => {
    const b = sharePaceBudget({ weeklyLimit: 7, articlesWritten: 4, rewritesDone: 0, tasksPending: 1, refreshDays: 2 });
    expect(b).toMatchObject({ used: 4, reserved: 1, articlesLeft: 2, improvementsLeft: 3 });
  });

  it("reserves no more than the site's improvement days can run, and none when refreshes are off", () => {
    expect(sharePaceBudget({ weeklyLimit: 7, articlesWritten: 0, rewritesDone: 0, tasksPending: 5, refreshDays: 2 }).reserved).toBe(2);
    expect(sharePaceBudget({ weeklyLimit: 7, articlesWritten: 0, rewritesDone: 0, tasksPending: 5, refreshDays: 0 }).reserved).toBe(0);
  });

  it("never goes negative, and a pace of 0 or unset leaves no room for either", () => {
    expect(sharePaceBudget({ weeklyLimit: 3, articlesWritten: 9, rewritesDone: 1, tasksPending: 2, refreshDays: 2 })).toMatchObject({
      articlesLeft: 0, improvementsLeft: 0,
    });
    expect(sharePaceBudget({ weeklyLimit: 0, articlesWritten: 0, rewritesDone: 0, tasksPending: 1, refreshDays: 1 }).improvementsLeft).toBe(0);
    expect(sharePaceBudget({ weeklyLimit: null, articlesWritten: 0, rewritesDone: 0, tasksPending: 0, refreshDays: 0 }).limit).toBe(0);
  });

  it("says what was spent in both units", () => {
    expect(describePaceBudget(sharePaceBudget({ weeklyLimit: 7, articlesWritten: 2, rewritesDone: 1, tasksPending: 1, refreshDays: 2 })))
      .toBe("3 of 7 this week (2 articles + 1 improvement, 1 reserved for an improvement)");
    expect(describePaceBudget(sharePaceBudget({ weeklyLimit: 7, articlesWritten: 1, rewritesDone: 0, tasksPending: 0, refreshDays: 2 })))
      .toBe("1 of 7 this week (1 article)");
  });
});

describe("readPaceBudget", () => {
  /** Counts per table, and a record of every filter each read applied. */
  function client(counts: Record<string, number>) {
    const calls: Array<{ table: string; filters: Array<[string, ...unknown[]]> }> = [];
    return {
      calls,
      supabase: {
        from: (table: string) => {
          const call = { table, filters: [] as Array<[string, ...unknown[]]> };
          calls.push(call);
          const q = {
            select: () => q,
            eq: (...a: unknown[]) => { call.filters.push(["eq", ...a]); return q; },
            gte: (...a: unknown[]) => { call.filters.push(["gte", ...a]); return q; },
            lte: (...a: unknown[]) => { call.filters.push(["lte", ...a]); return q; },
            then: (r: (v: { count: number; error: null }) => unknown) => r({ count: counts[table] ?? 0, error: null }),
          };
          return q;
        },
      } as never,
    };
  }

  const now = new Date("2026-09-05T12:00:00Z");

  it("sums drafts and rewrites from their own tables, so nothing is counted twice", async () => {
    const { supabase } = client({ articles: 3, refresh_executions: 1, refresh_tasks: 1 });
    const b = await readPaceBudget(supabase, "ws1", { weeklyLimit: 7, refreshEnabled: true, refreshDays: [2, 4], now });
    expect(b).toMatchObject({ articlesWritten: 3, rewritesDone: 1, used: 4, reserved: 1, articlesLeft: 2, improvementsLeft: 3 });
  });

  it("scopes every read to the workspace and the trailing week", async () => {
    const { supabase, calls } = client({});
    await readPaceBudget(supabase, "ws1", { weeklyLimit: 7, refreshEnabled: true, refreshDays: [1], now });
    expect(calls.map((c) => c.table).sort()).toEqual(["articles", "refresh_executions", "refresh_tasks"]);
    for (const c of calls) expect(c.filters).toContainEqual(["eq", "workspace_id", "ws1"]);

    const since = "2026-08-29T12:00:00.000Z";
    expect(calls.find((c) => c.table === "articles")!.filters).toEqual(
      expect.arrayContaining([["eq", "generated_autonomously", true], ["gte", "created_at", since]]),
    );
    expect(calls.find((c) => c.table === "refresh_executions")!.filters).toContainEqual(["gte", "created_at", since]);
    // Pending tasks: only those due within the coming week hold a slot.
    expect(calls.find((c) => c.table === "refresh_tasks")!.filters).toEqual(
      expect.arrayContaining([["eq", "status", "scheduled"], ["lte", "scheduled_for", "2026-09-11"]]),
    );
  });

  it("reserves nothing for a site whose refreshes are switched off, whatever is scheduled", async () => {
    const { supabase } = client({ refresh_tasks: 3 });
    const b = await readPaceBudget(supabase, "ws1", { weeklyLimit: 7, refreshEnabled: false, refreshDays: [1, 3], now });
    expect(b.reserved).toBe(0);
    expect(b.articlesLeft).toBe(7);
  });
});

describe("both crons spend the same budget", () => {
  // Like lib/plan/__tests__/cron-pause-guard: the routes are not callable
  // from vitest, so the source is read. A cron that kept its own count would
  // be the double-spend this module exists to remove.
  const CRON_DIR = join(__dirname, "..", "..", "..", "app", "api", "cron");
  for (const route of ["generate", "refresh"]) {
    it(`${route} reads lib/plan/pace-budget rather than counting for itself`, () => {
      const src = readFileSync(join(CRON_DIR, route, "route.ts"), "utf8");
      expect(src).toContain("readPaceBudget(");
      expect(src).toContain('from "@/lib/plan/pace-budget"');
    });
  }

  it("generate stops on the article side of the budget, refresh on the improvement side", () => {
    expect(readFileSync(join(CRON_DIR, "generate", "route.ts"), "utf8")).toContain("budget.articlesLeft <= 0");
    expect(readFileSync(join(CRON_DIR, "refresh", "route.ts"), "utf8")).toContain("budget.improvementsLeft <= 0");
  });

  it("generate skips a due entry the plan has frozen instead of writing something else", () => {
    const src = readFileSync(join(CRON_DIR, "generate", "route.ts"), "utf8");
    expect(src).toContain("readFrozenEntries(");
    expect(src).toContain("frozen.ids.has(due.entryId)");
  });
});
