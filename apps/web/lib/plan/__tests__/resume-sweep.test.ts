import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeDb } from "./fake-postgrest";

/**
 * The scheduled writer finishing what a trial start began when a function
 * time limit cut it short (lib/plan/resume-sweep.ts). Pinned here: a
 * checkout's follow-up that never finished is sent again, and one that is
 * finished or still inside its lease is not; a week whose chain of drafts
 * stopped is started again with what it owes, and one still being written is
 * left alone; and a sweep that cannot read is a line in the report, never a
 * failed run.
 */

vi.mock("@/lib/plan/pace-budget", () => ({ readPaceBudget: async () => ({ articlesLeft: 13 }) }));
vi.mock("@/lib/plan/frozen", () => ({ readFrozenEntries: async () => ({ ids: new Set(), reason: null }) }));
vi.mock("@/lib/onboarding/plan", () => ({ schedulePlan: async () => [] }));
vi.mock("@/lib/observability/record", () => ({ recordEvent: async () => true }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ service: true }) }));
vi.mock("@/lib/billing/spend-gate", () => ({ canSpend: async () => ({ allowed: true, reason: "plan", quota: { remaining: null }, message: null }) }));

import { sweepUnfinishedResumes } from "../resume-sweep";
import { CLAIM_LEASE_MS } from "../draft-claim";

const NOW = new Date("2026-09-26T07:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const site = (over: Record<string, unknown> = {}) => ({
  id: "ws1",
  account_id: "acc1",
  auto_generate: true,
  status: "on",
  auto_generate_weekly_limit: 7,
  refresh_enabled: false,
  refresh_days: null,
  trial_resume_key: null,
  trial_resume_claimed_at: null,
  trial_resumed_at: null,
  ...over,
});

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspace_id: "ws1",
  status: "queue",
  article_id: null,
  keyword: `topic ${id}`,
  keyword_id: `k-${id}`,
  scheduled_date: "2026-09-28",
  created_at: "2026-09-25T10:00:00.000Z",
  draft_claimed_at: null,
  draft_claimed_by: null,
  draft_failed_at: null,
  draft_failure: null,
  draft_owed_at: null,
  ...over,
});

let sent: Array<Record<string, unknown>> = [];
const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
  sent.push(JSON.parse(init.body) as Record<string, unknown>);
  return new Response("{}", { status: 200 });
});
const dispatch = vi.fn(async () => {});
const deps = { baseUrl: "https://app.example", secret: "cron-secret", fetchImpl: fetchImpl as never, now: NOW, dispatch };

beforeEach(() => {
  sent = [];
  fetchImpl.mockClear();
  dispatch.mockClear();
});

describe("a checkout's follow-up that never finished", () => {
  it("is sent again when nobody ever claimed it, or its claim ran out; a trial account gets its week too", async () => {
    const db = new FakeDb({
      workspaces: [
        // Owed, the hand-off never arrived.
        site({ id: "ws1", account_id: "acc1", trial_resume_key: "sub_1" }),
        // Owed, claimed, and cut off twenty minutes ago.
        site({ id: "ws2", account_id: "acc2", trial_resume_key: "sub_2", trial_resume_claimed_at: minutesAgo(CLAIM_LEASE_MS / 60_000 + 5) }),
      ],
      accounts: [
        { id: "acc1", plan_status: "trialing" },
        { id: "acc2", plan_status: "active" },
      ],
    });
    const out = await sweepUnfinishedResumes(db.client, deps);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { accountId: "acc1", key: "sub_1", draftWeek: true },
      // The trial is over, or there never was one: the month only.
      { accountId: "acc2", key: "sub_2", draftWeek: false },
    ]);
    expect(out.lines).toHaveLength(2);
  });

  it("is left alone when it finished, or when a resume may still be running it", async () => {
    const db = new FakeDb({
      workspaces: [
        site({ id: "ws1", trial_resume_key: "sub_1", trial_resume_claimed_at: minutesAgo(30), trial_resumed_at: minutesAgo(29) }),
        site({ id: "ws2", trial_resume_key: "sub_1", trial_resume_claimed_at: minutesAgo(2) }),
        site({ id: "ws3" }),
      ],
      accounts: [{ id: "acc1", plan_status: "trialing" }],
    });
    const out = await sweepUnfinishedResumes(db.client, deps);
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.lines).toEqual([]);
  });

  it("sends one follow-up per checkout, however many of its sites are owed", async () => {
    const db = new FakeDb({
      workspaces: [site({ id: "ws1", trial_resume_key: "sub_1" }), site({ id: "ws2", trial_resume_key: "sub_1" })],
      accounts: [{ id: "acc1", plan_status: "trialing" }],
    });
    await sweepUnfinishedResumes(db.client, deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("a week whose chain of drafts stopped", () => {
  it("is started again with exactly what it owes, as a batch", async () => {
    const db = new FakeDb({
      workspaces: [site({ trial_resume_key: "sub_1", trial_resume_claimed_at: minutesAgo(600), trial_resumed_at: minutesAgo(598) })],
      calendar_entries: [
        entry("a", { draft_owed_at: minutesAgo(600), scheduled_date: "2026-09-27" }),
        entry("b", { draft_owed_at: minutesAgo(600), scheduled_date: "2026-09-29" }),
        // Written already.
        entry("c", { draft_owed_at: minutesAgo(600), article_id: "art-c", status: "scheduled" }),
        // Next week's: not owed, stays on its day.
        entry("d", { scheduled_date: "2026-10-03" }),
      ],
    });
    const out = await sweepUnfinishedResumes(db.client, deps);
    await out.settled;
    expect(out.started).toBe(2);
    expect(sent.map((b) => b.entryId).sort()).toEqual(["a", "b"]);
    expect(sent.every((b) => String(b.claim).startsWith("resume:"))).toBe(true);
    expect(out.lines).toEqual(["ws1: started the rest of the trial's week again, 2 drafts"]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("is not burst weeks later: an entry owed that long is the scheduled writer's, at the site's pace", async () => {
    const db = new FakeDb({
      workspaces: [site({ trial_resume_key: "sub_1", trial_resumed_at: minutesAgo(20 * 24 * 60) })],
      calendar_entries: [entry("a", { draft_owed_at: minutesAgo(20 * 24 * 60), scheduled_date: "2026-09-08" })],
    });
    const out = await sweepUnfinishedResumes(db.client, deps);
    expect(out.started).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("is left to its chain while any of its drafts is still being written", async () => {
    const db = new FakeDb({
      workspaces: [site({ trial_resume_key: "sub_1", trial_resumed_at: minutesAgo(5) })],
      calendar_entries: [
        entry("a", { draft_owed_at: minutesAgo(5), draft_claimed_at: minutesAgo(4), draft_claimed_by: "trial:sub_1" }),
        entry("b", { draft_owed_at: minutesAgo(5) }),
      ],
    });
    const out = await sweepUnfinishedResumes(db.client, deps);
    expect(out.started).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("is left to the resume being sent again for the same site", async () => {
    const db = new FakeDb({
      workspaces: [site({ trial_resume_key: "sub_1" })],
      accounts: [{ id: "acc1", plan_status: "trialing" }],
      calendar_entries: [entry("a", { draft_owed_at: minutesAgo(700) })],
    });
    const out = await sweepUnfinishedResumes(db.client, deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(out.started).toBe(0);
  });
});

it("never throws: a read that fails is a line in the cron's report", async () => {
  const broken = {
    from: () => {
      throw new Error("relation does not exist");
    },
  } as never;
  const out = await sweepUnfinishedResumes(broken, deps);
  expect(out.lines).toEqual([
    "unfinished resumes could not be read: relation does not exist",
    "owed drafts could not be read: relation does not exist",
  ]);
  expect(out.started).toBe(0);
});
