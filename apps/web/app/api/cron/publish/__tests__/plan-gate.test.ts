import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * cron/publish and an account with no plan (assessment 2026-10-25).
 *
 * Articles approved and scheduled while a trial ran stayed `scheduled` after
 * it ended or was cancelled, and the cron sent them to the customer's site.
 * The publisher now refuses them (lib/publishing/plan-gate.ts); the cron
 * leaves them scheduled, logs and emails no failure, and reads past them so
 * a paying site's article behind them still ships.
 */

const calls = vi.hoisted(() => ({
  published: [] as string[],
  articleUpdates: [] as unknown[],
  overrideQueries: [] as string[][],
}));

vi.mock("@/lib/cron-auth", () => ({ isAuthorizedCron: () => true }));
vi.mock("@/lib/observability/cron", () => ({ observedCron: (_name: string, fn: unknown) => fn }));
vi.mock("@/lib/publishing/auto-approve", () => ({ runAutoApprovals: async () => [] }));
vi.mock("@/lib/email/held-digest", () => ({ sendHeldDigests: async () => [] }));
vi.mock("@/lib/email/article-events", () => ({
  announceArticlePublished: vi.fn(async () => "emailed"),
  announcePublishFailed: vi.fn(async () => "emailed"),
}));
vi.mock("@/lib/publishing/log", () => ({
  recordPublish: vi.fn(async () => undefined),
  lastSuccessfulPushAt: async () => null,
}));
vi.mock("@/lib/cms/blog-url", () => ({ urlIsLive: async () => false, deriveBlogBaseUrl: async () => null }));
vi.mock("@/lib/seo/indexing", () => ({ submitForIndexing: async () => ({}) }));
vi.mock("@/lib/publishing/core", async () => {
  const { PlanRequiredError } = await import("@/lib/publishing/plan-gate");
  class PublishError extends Error {}
  return {
    PublishError,
    publishArticleCore: async (_db: unknown, id: string) => {
      if (id.startsWith("lapsed")) throw new PlanRequiredError();
      calls.published.push(id);
      return { destinationId: "wi1", publishMode: "publish" };
    },
  };
});

/** Due overrides: two from a site with no plan, then a paying site's article behind them. */
const due = [
  { id: "lapsed-1", workspace_id: "w-lapsed" },
  { id: "lapsed-2", workspace_id: "w-lapsed" },
  { id: "paid-1", workspace_id: "w-paid" },
];

function db() {
  return {
    from: (table: string) => {
      const filters: string[] = [];
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "lte", "order", "limit"]) {
        q[m] = (...a: unknown[]) => {
          filters.push(`${m}(${a.map(String).join(",")})`);
          return q;
        };
      }
      q.update = (row: unknown) => {
        calls.articleUpdates.push(row);
        return { eq: async () => ({ error: null }) };
      };
      q.then = (resolve: (v: unknown) => unknown) => {
        if (table !== "articles") return resolve({ data: [], error: null });
        const isOverride = filters.some((f) => f.startsWith("lte(scheduled_at"));
        if (!isOverride) return resolve({ data: [], error: null });
        calls.overrideQueries.push(filters);
        const leaveOut = filters.find((f) => f.startsWith("not(workspace_id,in"));
        // A page of two, so the paying site's article only comes up once the
        // lapsed site is left out of the query.
        const rows = due.filter((r) => !leaveOut?.includes(r.workspace_id)).slice(0, 2);
        return resolve({ data: rows, error: null });
      };
      return q;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => db() }));

beforeEach(() => {
  calls.published.length = 0;
  calls.articleUpdates.length = 0;
  calls.overrideQueries.length = 0;
});

describe("cron/publish with a site whose account holds no plan", () => {
  it("leaves its articles scheduled, reports no failure, and still ships the paying site's article", async () => {
    const { GET } = await import("../route");
    const { recordPublish } = await import("@/lib/publishing/log");
    const { announcePublishFailed } = await import("@/lib/email/article-events");

    const res = await (GET as (r: Request) => Promise<Response>)(new Request("https://app.altorank.co/api/cron/publish"));
    const body = await res.json();

    expect(calls.published).toEqual(["paid-1"]);
    expect(calls.articleUpdates).toEqual([]);
    expect(announcePublishFailed).not.toHaveBeenCalled();
    expect(vi.mocked(recordPublish).mock.calls.map((c) => (c[1] as { status: string }).status)).toEqual(["success"]);
    expect(body).toMatchObject({ published: 1, errors: 0 });
    expect(body.results).toContainEqual(
      expect.objectContaining({ articleId: "lapsed-1", status: "skipped", detail: "needs a plan" }),
    );
    // The second read left the lapsed site out.
    expect(calls.overrideQueries).toHaveLength(2);
    expect(calls.overrideQueries[1].join(" ")).toContain("not(workspace_id,in,(w-lapsed))");
  });
});
