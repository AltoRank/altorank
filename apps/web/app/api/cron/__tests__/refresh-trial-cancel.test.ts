import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * cron/refresh after a trial is cancelled before its first charge. A
 * scheduled rewrite is a draft (lib/billing/trial-hold.ts): it pays for a
 * brief and a model call, and the subscription stays `trialing` to its last
 * day, so the account read as paid and kept being rewritten for (assessment
 * 2026-09-29). A paid plan set to cancel at period end keeps its rewrites.
 */

const { getQuota, analyzeWorkspace, runRefreshTask } = vi.hoisted(() => ({
  getQuota: vi.fn(),
  analyzeWorkspace: vi.fn(),
  runRefreshTask: vi.fn(),
}));

const TODAY = new Date().getUTCDay();
const workspaces = [{ id: "ws-1", domain: "acme-agency.example", account_id: "acc-1", refresh_days: [TODAY], refresh_last_analyzed_at: null, auto_generate_weekly_limit: 7 }];

function table(name: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self, eq: self, neq: self, gte: self, lte: self, order: self, limit: self,
    maybeSingle: async () => ({ data: name === "refresh_tasks" ? { id: "task-1", scheduled_for: "2026-09-29" } : null, error: null }),
    then: (r: (v: unknown) => unknown) => r(name === "workspaces" ? { data: workspaces, error: null } : { data: [], count: 0, error: null }),
  });
  return chain;
}
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from: (n: string) => table(n) }) }));
vi.mock("@/lib/observability/cron", () => ({ observedCron: (_name: string, fn: unknown) => fn }));
vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: (...a: unknown[]) => getQuota(...a),
}));
vi.mock("@/lib/refresh/detect", () => ({ analyzeWorkspace: (...a: unknown[]) => analyzeWorkspace(...a) }));
vi.mock("@/lib/refresh/rewrite", () => ({ runRefreshTask: (...a: unknown[]) => runRefreshTask(...a) }));
vi.mock("@/lib/plan/pace-budget", () => ({ readPaceBudget: async () => ({ improvementsLeft: 1 }), describePaceBudget: () => "" }));
vi.mock("@/lib/email/lifecycle", () => ({ notifyRefreshReady: async () => ({ sent: 0, skipped: 0, failed: 0 }) }));

import { GET } from "../refresh/route";

const req = () => new Request("http://localhost/api/cron/refresh", { headers: { "x-cron-secret": "s" } });
const TRIAL_END = "2026-10-06T12:00:00.000Z";

beforeEach(() => {
  process.env.CRON_SECRET = "s";
  getQuota.mockReset();
  analyzeWorkspace.mockReset().mockResolvedValue({ pages: 1, created: 0, refreshed: 0 });
  runRefreshTask.mockReset().mockResolvedValue({ ok: false, error: "stop here" });
});

describe("cron/refresh after a trial cancel", () => {
  it("rewrites nothing for a cancelled trial, and says why", async () => {
    getQuota.mockResolvedValue({ limit: 100, used: 5, remaining: 95, reason: "plan", plan: "starter", trial: { endsAt: TRIAL_END, daysLeft: 5, cancelsAt: TRIAL_END } });
    const body = await (await (GET as unknown as (r: Request) => Promise<Response>)(req())).json();
    expect(body.results[0]).toMatchObject({ status: "skipped", rewrite: expect.stringMatching(/^Your trial is cancelled, so nothing new is drafted\./) });
    expect(runRefreshTask).not.toHaveBeenCalled();
    expect(analyzeWorkspace).not.toHaveBeenCalled();
  });

  it("still runs the day's rewrite for a paid plan set to cancel at period end", async () => {
    getQuota.mockResolvedValue({ limit: 100, used: 40, remaining: 60, reason: "plan", plan: "starter", trial: null });
    await (GET as unknown as (r: Request) => Promise<Response>)(req());
    expect(runRefreshTask).toHaveBeenCalledTimes(1);
  });
});
