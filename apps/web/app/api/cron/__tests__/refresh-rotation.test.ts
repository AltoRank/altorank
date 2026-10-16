import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

// ---------------------------------------------------------------------------
// The run's cap delays a site by a day, not a week, and not the same site
// ---------------------------------------------------------------------------
//
// cron/refresh has room for two rewrites a morning across every site. A third
// site due the same weekday used to be told "the next run starts here" - but
// the next run is tomorrow, not its weekday, so it waited a week; and the
// order (by last analysis) let the same sites win every week.

let f: FakeSupabase;
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => f }));
vi.mock("@/lib/observability/cron", () => ({ observedCron: (_n: string, fn: unknown) => fn }));
vi.mock("@/lib/billing/quota", async (orig) => ({
  ...(await orig<typeof import("@/lib/billing/quota")>()),
  getQuota: async () => ({ limit: 100, used: 1, remaining: 99, reason: "plan", plan: "starter", trial: null }),
}));
vi.mock("@/lib/refresh/detect", () => ({ analyzeWorkspace: async () => ({ reason: "ok", pages: 0, created: 0, refreshed: 0, retired: 0 }) }));
vi.mock("@/lib/plan/pace-budget", () => ({ readPaceBudget: async () => ({ improvementsLeft: 5 }), describePaceBudget: () => "" }));
vi.mock("@/lib/email/lifecycle", () => ({ notifyRefreshReady: async () => ({ sent: 0, skipped: 0, failed: 0 }) }));

/** A rewrite: the task is done and an execution exists, as runRefreshTask leaves them. */
const runRefreshTask = vi.fn(async (_db: unknown, taskId: string) => {
  const t = f.tables.refresh_tasks.find((r) => r.id === taskId)!;
  t.status = "done";
  f.tables.refresh_executions.push({ id: `x-${taskId}`, workspace_id: t.workspace_id, created_at: new Date().toISOString() });
  return {
    ok: true,
    result: { executionId: `x-${taskId}`, hunks: 1, changed: 1, checks: 0, factCheck: { verdict: "clean", flagged: 0 }, pageTitle: null, pageUrl: "https://x" },
  };
});
vi.mock("@/lib/refresh/rewrite", () => ({ runRefreshTask: (...a: [unknown, string]) => runRefreshTask(...a) }));

const { GET } = await import("../refresh/route");
const call = async () => {
  const res = await (GET as unknown as (r: Request) => Promise<Response>)(
    new Request("http://localhost/api/cron/refresh", { headers: { "x-cron-secret": "s" } }),
  );
  return (await res.json()) as { rewrites: number; results: { workspaceId: string; rewrite?: string }[] };
};
const at = (iso: string) => vi.setSystemTime(new Date(iso));

const site = (id: string) => ({
  id,
  domain: `${id}.example`,
  account_id: `acc-${id}`,
  status: "active",
  refresh_enabled: true,
  refresh_days: [1],
  refresh_last_analyzed_at: "2026-10-11T00:00:00Z",
  auto_generate_weekly_limit: 7,
});
const due = (ws: string, scheduled_for: string, created_at: string) => ({
  id: `${ws}-${scheduled_for}`,
  candidate_id: `c-${ws}`,
  workspace_id: ws,
  status: "scheduled",
  scheduled_for,
  created_at,
});

beforeEach(() => {
  process.env.CRON_SECRET = "s";
  vi.useFakeTimers({ toFake: ["Date"] });
  runRefreshTask.mockClear();
  f = fakeSupabase({
    workspaces: [site("a"), site("b"), site("c")],
    refresh_tasks: ["a", "b", "c"].map((w) => due(w, "2026-10-12", "2026-10-10T09:00:00Z")),
    refresh_executions: [],
  });
});
afterEach(() => vi.useRealTimers());

describe("cron/refresh under its two-a-run cap", () => {
  it("runs the capped site the next morning instead of next week", async () => {
    at("2026-10-12T07:30:00Z"); // Monday, every site's day
    const mon = await call();
    expect(mon.rewrites).toBe(2);
    const capped = mon.results.find((r) => r.rewrite?.startsWith("run limit reached"))!;
    expect(capped).toBeDefined();

    at("2026-10-13T07:30:00Z"); // Tuesday, nobody's day
    const tue = await call();
    expect(tue.rewrites).toBe(1);
    expect(runRefreshTask).toHaveBeenLastCalledWith(expect.anything(), `${capped.workspaceId}-2026-10-12`);
    expect(tue.results.find((r) => r.workspaceId === capped.workspaceId)!.rewrite).toMatch(/^catch-up for 2026-10-12, execution/);

    // And not again on Wednesday: the week's one rewrite happened.
    at("2026-10-14T07:30:00Z");
    expect((await call()).rewrites).toBe(0);
  });

  it("does not delay the same site two weeks running", async () => {
    at("2026-10-12T07:30:00Z");
    const first = (await call()).results.find((r) => r.rewrite?.startsWith("run limit reached"))!.workspaceId;
    at("2026-10-13T07:30:00Z");
    await call();

    // Next Monday, every site has a new task again.
    for (const w of ["a", "b", "c"]) f.tables.refresh_tasks.push(due(w, "2026-10-19", "2026-10-15T09:00:00Z"));
    at("2026-10-19T07:30:00Z");
    const next = await call();
    const cappedAgain = next.results.find((r) => r.rewrite?.startsWith("run limit reached"))!.workspaceId;
    expect(cappedAgain).not.toBe(first);
    expect(next.results.find((r) => r.workspaceId === first)!.rewrite).toMatch(/^execution/);
  });
});
