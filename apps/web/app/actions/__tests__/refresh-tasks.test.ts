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
const { needsPlanToShip } = vi.hoisted(() => ({ needsPlanToShip: vi.fn(async () => false) }));
vi.mock("@/lib/billing/quota", async () => ({
  ...(await vi.importActual<typeof import("@/lib/billing/quota")>("@/lib/billing/quota")),
  needsPlanToShip,
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
  needsPlanToShip.mockResolvedValue(false);
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
