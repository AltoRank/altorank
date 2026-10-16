import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

// ---------------------------------------------------------------------------
// Cancel, reschedule and dismiss reach a rewrite that was cut off mid-run
// ---------------------------------------------------------------------------
//
// They matched `scheduled`/`failed` only, so a task the platform killed while
// `running` could not be withdrawn, moved or cleared by anyone. A task that
// is genuinely running is still left to finish.

let f: FakeSupabase;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => f, createServiceClient: () => f }));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ accountId: "acc1", role: "owner", user: { id: "u1", email: "a@b.co" } })),
}));
const PAID = { limit: 100, used: 4, remaining: 96, reason: "plan", plan: "starter", trial: null };
const NO_PLAN = { limit: 7, used: 7, remaining: 0, reason: "no-plan", plan: null, trial: null };
const { getQuota } = vi.hoisted(() => ({ getQuota: vi.fn() }));
vi.mock("@/lib/billing/quota", async () => ({
  ...(await vi.importActual<typeof import("@/lib/billing/quota")>("@/lib/billing/quota")),
  getQuota,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { cancelTask, dismissCandidate, scheduleCandidate } = await import("../refresh");

const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
const justNow = new Date(Date.now() - 10_000).toISOString();

function seed(taskOver: Record<string, unknown>, ws: Record<string, unknown> = {}) {
  f = fakeSupabase({
    workspaces: [{ id: "ws1", account_id: "acc1", refresh_enabled: true, refresh_days: [1, 4], ...ws }],
    refresh_candidates: [
      { id: "c1", workspace_id: "ws1", url: "https://acme.example/a", opportunity: "thin", evidence: {}, dismissed_at: null },
    ],
    refresh_tasks: [
      { id: "t1", candidate_id: "c1", workspace_id: "ws1", status: "running", scheduled_for: "2026-10-01", created_at: longAgo, started_at: longAgo, error: null, ...taskOver },
    ],
  });
}

beforeEach(() => {
  getQuota.mockReset().mockResolvedValue(PAID);
});

describe("a rewrite cut off mid-run", () => {
  it("can be cancelled", async () => {
    seed({});
    await cancelTask("t1");
    expect(f.tables.refresh_tasks[0].status).toBe("cancelled");
  });

  it("is cancelled with its candidate on dismiss", async () => {
    seed({});
    await dismissCandidate("c1");
    expect(f.tables.refresh_tasks[0].status).toBe("cancelled");
    expect(f.tables.refresh_candidates[0].dismissed_at).toBeTruthy();
  });

  it("is moved, not duplicated, on reschedule", async () => {
    seed({});
    const out = await scheduleCandidate("c1", "2026-10-20");
    expect(out).toEqual({ ok: true, id: "t1" });
    expect(f.tables.refresh_tasks).toHaveLength(1);
    expect(f.tables.refresh_tasks[0]).toMatchObject({ status: "scheduled", scheduled_for: "2026-10-20", error: null });
  });
});

describe("a rewrite running now", () => {
  it("is not cancelled under the cron", async () => {
    seed({ started_at: justNow });
    await cancelTask("t1");
    expect(f.tables.refresh_tasks[0].status).toBe("running");
  });

  it("is not pulled back to scheduled, and the refusal says why", async () => {
    seed({ started_at: justNow });
    const out = await scheduleCandidate("c1", "2026-10-20");
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/being rewritten right now/) });
    expect(f.tables.refresh_tasks[0]).toMatchObject({ status: "running", scheduled_for: "2026-10-01" });
  });
});

// ---------------------------------------------------------------------------
// Scheduling a rewrite that would never run is refused
// ---------------------------------------------------------------------------
//
// cron/refresh picks up tasks only for sites with scheduled rewrites on, a
// weekday picked, and an account entitled to scheduled work. A task outside
// that sat on the calendar and in the plan's capacity and never ran.

describe("scheduleCandidate on a site whose rewrites cannot run", () => {
  const fresh = (ws: Record<string, unknown>) => {
    seed({}, ws);
    f.tables.refresh_tasks = [];
  };

  it("refuses with the switch off, and says where to turn it on", async () => {
    fresh({ refresh_enabled: false });
    const out = await scheduleCandidate("c1", "2026-10-20");
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/off for this site.*Settings → Improvements/) });
    expect(f.tables.refresh_tasks).toHaveLength(0);
  });

  it("refuses with no weekday picked", async () => {
    fresh({ refresh_days: [] });
    const out = await scheduleCandidate("c1", "2026-10-20");
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/No weekday/) });
    expect(f.tables.refresh_tasks).toHaveLength(0);
  });

  it("refuses without a plan, and names the Billing page", async () => {
    fresh({});
    getQuota.mockResolvedValue(NO_PLAN);
    const out = await scheduleCandidate("c1", "2026-10-20");
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/need a plan.*Billing/) });
    expect(f.tables.refresh_tasks).toHaveLength(0);
  });

  it("does not move an existing task onto a site that cannot run it", async () => {
    seed({ status: "scheduled", started_at: null }, { refresh_enabled: false });
    const out = await scheduleCandidate("c1", "2026-10-20");
    expect(out.ok).toBe(false);
    expect(f.tables.refresh_tasks[0].scheduled_for).toBe("2026-10-01");
  });

  it("schedules when the site can run it", async () => {
    fresh({});
    const out = await scheduleCandidate("c1", "2026-10-20");
    expect(out.ok).toBe(true);
    expect(f.tables.refresh_tasks).toEqual([expect.objectContaining({ candidate_id: "c1", scheduled_for: "2026-10-20" })]);
  });

  it("cancel still works with the switch off", async () => {
    seed({ status: "scheduled", started_at: null }, { refresh_enabled: false });
    await cancelTask("t1");
    expect(f.tables.refresh_tasks[0].status).toBe("cancelled");
  });
});
