import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeDb } from "./fake-postgrest";

/**
 * The trial starts: the month is topped up and the rest of this week is
 * drafted now, one entry per request (lib/plan/resume-week.ts). Pinned here:
 * one delivery sends each of this week's entries exactly once; the same event
 * again sends nothing; a spend refusal is written on the entries and sends
 * nothing; next week is left to the scheduled writer; the pace and the
 * in-flight ceiling bound how many start; and a resume cut off halfway can be
 * run again once its lease is out, while a finished one never runs twice.
 */

const { budget, topUp, events } = vi.hoisted(() => ({
  budget: { articlesLeft: 6 },
  topUp: vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []),
  events: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/plan/pace-budget", () => ({ readPaceBudget: async () => ({ ...budget }) }));
vi.mock("@/lib/plan/frozen", () => ({ readFrozenEntries: async () => ({ ids: new Set(), reason: null }) }));
vi.mock("@/lib/onboarding/plan", () => ({ schedulePlan: (...a: unknown[]) => topUp(...a) }));
vi.mock("@/lib/observability/record", () => ({ recordEvent: async (e: Record<string, unknown>) => (events.push(e), true) }));
vi.mock("@/lib/billing/spend-gate", () => ({ canSpend: async () => ({ allowed: true, reason: "plan", quota: { remaining: null }, message: null }) }));

import {
  claimSiteResume,
  continueFrom,
  draftRestOfWeek,
  draftsToStart,
  oweResume,
  planWeekContaining,
  RESUME_LEASE_MS,
  RESUME_MAX_IN_FLIGHT,
  resumeAccount,
  type ResumeSite,
} from "../resume-week";

const NOW = new Date("2026-09-25T10:00:00.000Z");

const site: ResumeSite & Record<string, unknown> = {
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
  publishing_cadences: null,
};

let seq = 0;
const entry = (date: string, over: Record<string, unknown> = {}) => ({
  id: `e-${date}-${++seq}`,
  workspace_id: "ws1",
  status: "queue",
  article_id: null,
  keyword: `topic ${date}`,
  keyword_id: `k-${date}`,
  scheduled_date: date,
  created_at: `2026-09-24T12:00:${String(seq).padStart(2, "0")}.000Z`,
  draft_claimed_at: null,
  draft_claimed_by: null,
  draft_failed_at: null,
  draft_failure: null,
  draft_owed_at: null,
  ...over,
});

/**
 * The calendar a gated signup has the day after its trial starts: the first
 * article on the 24th (written), the top-up's entries from the 25th, and the
 * plan's week counted from the 24th - so this week runs to the 30th.
 */
function calendar() {
  seq = 0;
  return [
    entry("2026-09-24", { status: "scheduled", article_id: "a-first" }),
    ...["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"].map((d) => entry(d)),
    entry("2026-10-01"),
    entry("2026-10-02"),
  ];
}

/** The entries dated in the rest of this week, the 25th to the 30th. */
const thisWeek = (db: FakeDb) =>
  db.rows("calendar_entries").filter((e) => String(e.scheduled_date) >= "2026-09-25" && String(e.scheduled_date) <= "2026-09-30");

let sent: Array<Record<string, unknown>> = [];
let answer: (body: Record<string, unknown>) => Response = () => new Response("{}", { status: 200 });
const fetchImpl = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
  const body = JSON.parse(init.body) as Record<string, unknown>;
  sent.push({ ...body, secret: init.headers["x-cron-secret"] });
  return answer(body);
});
const deps = { baseUrl: "https://app.example", secret: "cron-secret", fetchImpl: fetchImpl as never, now: NOW };

beforeEach(() => {
  budget.articlesLeft = 6;
  topUp.mockReset();
  topUp.mockImplementation(async () => []);
  events.length = 0;
  sent = [];
  answer = () => new Response("{}", { status: 200 });
  fetchImpl.mockClear();
});

describe("planWeekContaining", () => {
  it("counts weeks from the site's first calendar entry, the week the person was shown", () => {
    expect(planWeekContaining("2026-09-24", NOW)).toEqual({ from: "2026-09-25", until: "2026-09-30" });
    // Three weeks on, it is that week that finishes.
    expect(planWeekContaining("2026-09-03", NOW)).toEqual({ from: "2026-09-25", until: "2026-09-30" });
    expect(planWeekContaining("2026-09-25", NOW)).toEqual({ from: "2026-09-25", until: "2026-10-01" });
  });
  it("starts the week today with no entry to count from, or one in the future", () => {
    expect(planWeekContaining(null, NOW)).toEqual({ from: "2026-09-25", until: "2026-10-01" });
    expect(planWeekContaining("2026-10-04", NOW)).toEqual({ from: "2026-09-25", until: "2026-10-01" });
  });
});

describe("draftsToStart", () => {
  it("is the least of what is waiting, the pace left, and the in-flight ceiling", () => {
    expect(draftsToStart({ waiting: 6, articlesLeft: 13, inFlight: 0, draftingRows: 0 })).toBe(RESUME_MAX_IN_FLIGHT);
    expect(draftsToStart({ waiting: 6, articlesLeft: 2, inFlight: 0, draftingRows: 0 })).toBe(2);
    expect(draftsToStart({ waiting: 1, articlesLeft: 13, inFlight: 0, draftingRows: 0 })).toBe(1);
  });
  it("takes claims with no row yet off the pace, and does not count a claim twice", () => {
    // Three claimed, none has its row yet: the budget has not seen them.
    expect(draftsToStart({ waiting: 6, articlesLeft: 5, inFlight: 3, draftingRows: 0 })).toBe(2);
    // Three claimed, all three rows exist and are already in articlesLeft.
    expect(draftsToStart({ waiting: 6, articlesLeft: 5, inFlight: 3, draftingRows: 3 })).toBe(3);
    expect(draftsToStart({ waiting: 6, articlesLeft: 13, inFlight: RESUME_MAX_IN_FLIGHT, draftingRows: 6 })).toBe(0);
  });
});

describe("draftRestOfWeek", () => {
  it("sends each of the rest of this week's entries once, with its claim, and leaves next week alone", async () => {
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [site] });
    const out = await draftRestOfWeek(db.client, site, { by: "trial:sub_1", ...deps });
    await out.settled;

    const week = thisWeek(db);
    expect(out.week).toEqual({ from: "2026-09-25", until: "2026-09-30" });
    expect(sent.map((b) => b.entryId).sort()).toEqual(week.map((e) => e.id).sort());
    expect(sent.every((b) => b.claim === "trial:sub_1" && b.secret === "cron-secret")).toBe(true);
    expect(week.every((e) => e.draft_claimed_by === "trial:sub_1" && e.draft_owed_at === NOW.toISOString())).toBe(true);
    // Next week is the scheduled writer's, on its days: neither owed nor claimed.
    const later = db.rows("calendar_entries").filter((e) => (e.scheduled_date as string) > "2026-09-30");
    expect(later.every((e) => e.draft_claimed_at === null && e.draft_owed_at === null)).toBe(true);
    expect(fetchImpl.mock.calls.every((c) => c[0] === "https://app.example/api/internal/draft")).toBe(true);
  });

  it("sends nothing new the second time: every entry it could take is taken", async () => {
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [site] });
    await (await draftRestOfWeek(db.client, site, { by: "trial:sub_1", ...deps })).settled;
    const again = await draftRestOfWeek(db.client, site, { by: "trial:sub_1", ...deps });
    expect(again.started).toEqual([]);
    expect(sent).toHaveLength(6);
  });

  it("writes a spend refusal on the entries, says so where an operator looks, and sends nothing", async () => {
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [site] });
    const refuse = vi.fn(async () => ({ allowed: false, reason: "paused", quota: {}, message: "Billing and article generation are paused until 1 November." }));
    const out = await draftRestOfWeek(db.client, site, { by: "trial:sub_1", ...deps, canSpend: refuse as never });

    expect(out.refused).toContain("paused until 1 November");
    expect(sent).toHaveLength(0);
    const week = thisWeek(db);
    expect(week.every((e) => e.draft_failure === "Billing and article generation are paused until 1 November." && e.draft_claimed_at === null)).toBe(true);
    // Failed, so due to the scheduled writer's next run; not owed, so nothing
    // restarts a burst the gate refused.
    expect(week.every((e) => e.draft_owed_at === null)).toBe(true);
    expect(refuse).toHaveBeenCalledWith(expect.anything(), "acc1", { userEmail: null, workspaceId: "ws1", action: "scheduled-work" });
    expect(events[0]).toMatchObject({ level: "warn", source: "plan.resume", workspaceId: "ws1" });
  });

  it("starts no more than the week's pace has room for", async () => {
    budget.articlesLeft = 2;
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [site] });
    const out = await draftRestOfWeek(db.client, site, { by: "trial:sub_1", ...deps });
    expect(out.started).toHaveLength(2);
    // The earliest two, in plan order.
    expect(sent.map((b) => b.keyword)).toEqual(["topic 2026-09-25", "topic 2026-09-26"]);
  });

  it("keeps six in flight at most, and starts the next as each lands", async () => {
    budget.articlesLeft = 13;
    seq = 0;
    const rows = [
      entry("2026-09-24", { status: "scheduled", article_id: "a-first" }),
      ...["25", "25", "26", "26", "27", "27", "28", "28"].map((d) => entry(`2026-09-${d}`)),
    ];
    const db = new FakeDb({ calendar_entries: rows, workspaces: [site] });
    const first = await draftRestOfWeek(db.client, site, { by: "trial:sub_1", ...deps });
    expect(first.started).toHaveLength(RESUME_MAX_IN_FLIGHT);

    // One lands: its entry gets its article, and the draft route asks for the next.
    const landed = db.rows("calendar_entries").find((e) => e.id === first.started[0])!;
    Object.assign(landed, { article_id: "a-new", status: "scheduled" });
    const next = await continueFrom(db.client, "ws1", { by: "trial:sub_1", ...deps });
    expect(next.started).toBe(1);
    expect(next.done).toBe(false);
    expect(sent).toHaveLength(RESUME_MAX_IN_FLIGHT + 1);
  });

  it("says the batch is done when the last one lands and nothing is left", async () => {
    seq = 0;
    const db = new FakeDb({ calendar_entries: [entry("2026-09-24", { status: "scheduled", article_id: "a-first" }), entry("2026-09-26")], workspaces: [site] });
    const first = await draftRestOfWeek(db.client, site, { by: "trial:sub_1", ...deps });
    Object.assign(db.rows("calendar_entries").find((e) => e.id === first.started[0])!, { article_id: "a-new", status: "scheduled" });
    const next = await continueFrom(db.client, "ws1", { by: "trial:sub_1", ...deps });
    expect(next).toMatchObject({ started: 0, done: true });
  });

  it("records a request the draft route turned away, so the entry is handed back now", async () => {
    answer = (body) => new Response("{}", { status: body.keyword === "topic 2026-09-26" ? 503 : 200 });
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [site] });
    await (await draftRestOfWeek(db.client, site, { by: "trial:sub_1", ...deps })).settled;
    const refused = db.rows("calendar_entries").find((e) => e.keyword === "topic 2026-09-26")!;
    expect(refused.draft_failure).toBe("The draft could not be started (503).");
  });

  it("keeps the route's own reason when the route recorded one before answering 500", async () => {
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [site] });
    answer = (body) => {
      if (body.keyword === "topic 2026-09-26") {
        // What /api/internal/draft does when the writer throws: record, then 500.
        Object.assign(db.rows("calendar_entries").find((e) => e.id === body.entryId)!, { draft_failed_at: NOW.toISOString(), draft_failure: "The model timed out." });
        return new Response("{}", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    };
    await (await draftRestOfWeek(db.client, site, { by: "trial:sub_1", ...deps })).settled;
    expect(db.rows("calendar_entries").find((e) => e.keyword === "topic 2026-09-26")!.draft_failure).toBe("The model timed out.");
  });

  it("writes nothing for a site that is not set to write, or is paused", async () => {
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [site] });
    expect((await draftRestOfWeek(db.client, { ...site, auto_generate: false }, { by: "trial:sub_1", ...deps })).started).toEqual([]);
    expect((await draftRestOfWeek(db.client, { ...site, status: "paused" }, { by: "trial:sub_1", ...deps })).started).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("claims nothing on an install that cannot call itself, and leaves the week owed to the scheduled writer", async () => {
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [site] });
    const out = await draftRestOfWeek(db.client, site, { by: "trial:sub_1", now: NOW, secret: null, baseUrl: "https://app.example", fetchImpl: fetchImpl as never });
    expect(out.started).toEqual([]);
    expect(out.detail).toContain("left for the scheduled writer");
    expect(db.rows("calendar_entries").every((e) => e.draft_claimed_at === null)).toBe(true);
    // Owed now, so each is due to the scheduled writer's next run rather than to its own day.
    expect(thisWeek(db).every((e) => e.draft_owed_at === NOW.toISOString())).toBe(true);
  });

  it("drafts exactly what the trial opened when the chain runs past the week's last day", async () => {
    budget.articlesLeft = 2;
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [site] });
    const first = await draftRestOfWeek(db.client, site, { by: "trial:sub_1", ...deps });
    expect(first.started).toHaveLength(2);
    for (const id of first.started) Object.assign(db.rows("calendar_entries").find((e) => e.id === id)!, { article_id: `a-${id}`, status: "scheduled" });

    // The chain picks up just after midnight on the first day of the next week.
    budget.articlesLeft = 13;
    const next = await continueFrom(db.client, "ws1", { by: "trial:sub_1", ...deps, now: new Date("2026-10-01T00:05:00.000Z") });
    expect(next.started).toBe(4);
    const sentDates = sent.map((b) => String(b.keyword).replace("topic ", ""));
    expect(sentDates.every((d) => d <= "2026-09-30")).toBe(true);
    expect(sent).toHaveLength(6);
  });
});

describe("what a checkout owes each site", () => {
  it("is written for every site of the account, and a second delivery changes nothing", async () => {
    const db = new FakeDb({ workspaces: [{ ...site }, { ...site, id: "ws2" }, { ...site, id: "other", account_id: "acc2" }] });
    expect(await oweResume(db.client, "acc1", "sub_1")).toBe(2);
    expect(db.rows("workspaces").filter((w) => w.trial_resume_key === "sub_1").map((w) => w.id)).toEqual(["ws1", "ws2"]);
    // Finished on one site: a redelivered event must not reopen it.
    db.rows("workspaces")[0].trial_resumed_at = NOW.toISOString();
    expect(await oweResume(db.client, "acc1", "sub_1")).toBe(0);
    expect(db.rows("workspaces")[0].trial_resumed_at).toBe(NOW.toISOString());
    // A new checkout is owed afresh.
    expect(await oweResume(db.client, "acc1", "sub_9")).toBe(2);
    expect(db.rows("workspaces")[0]).toMatchObject({ trial_resume_key: "sub_9", trial_resumed_at: null, trial_resume_claimed_at: null });
  });

  it("is claimed by one caller, and by another only once the first one's lease is out", async () => {
    const db = new FakeDb({ workspaces: [{ ...site, trial_resume_key: "sub_1" }] });
    const racing = await Promise.all([1, 2, 3].map(() => claimSiteResume(db.client, "ws1", "sub_1", NOW)));
    expect(racing.filter(Boolean)).toHaveLength(1);
    expect(await claimSiteResume(db.client, "ws1", "sub_1", new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(await claimSiteResume(db.client, "ws1", "sub_1", new Date(NOW.getTime() + RESUME_LEASE_MS + 60_000))).toBe(true);
    // Not for a checkout it is not owed.
    expect(await claimSiteResume(db.client, "ws1", "sub_2", new Date(NOW.getTime() + 2 * RESUME_LEASE_MS))).toBe(false);
  });
});

describe("resumeAccount", () => {
  const owed = () => ({ ...site, trial_resume_key: "sub_1" });

  it("tops up the month and starts the week, once per checkout, and says so where an operator looks", async () => {
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [owed()] });
    const first = await resumeAccount(db.client, "acc1", { key: "sub_1", draftWeek: true, ...deps });
    await first.settled;
    expect(topUp).toHaveBeenCalledTimes(1);
    expect(topUp.mock.calls[0][3]).toMatchObject({ mode: "top-up" });
    expect(sent).toHaveLength(6);
    expect(db.rows("workspaces")[0]).toMatchObject({ trial_resume_key: "sub_1", trial_resumed_at: expect.any(String) });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "info", source: "plan.resume", accountId: "acc1", workspaceId: "ws1", context: { key: "sub_1", started: 6 } });

    // Stripe delivers the event again, or the scheduled writer's sweep sends it.
    const second = await resumeAccount(db.client, "acc1", { key: "sub_1", draftWeek: true, ...deps });
    await second.settled;
    expect(second.sites[0].skipped).toBe("already resumed for this checkout");
    expect(topUp).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(6);
  });

  it("runs again when the first run was cut off before it finished, and not while it may still be running", async () => {
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [owed()] });
    // A resume claimed the site and was cut off: claimed, never finished.
    expect(await claimSiteResume(db.client, "ws1", "sub_1", NOW)).toBe(true);

    const tooSoon = await resumeAccount(db.client, "acc1", { key: "sub_1", draftWeek: true, ...deps, now: new Date(NOW.getTime() + 60_000) });
    expect(tooSoon.sites[0].skipped).toBe("being resumed by another request");
    expect(topUp).not.toHaveBeenCalled();

    const later = new Date(NOW.getTime() + RESUME_LEASE_MS + 60_000);
    const again = await resumeAccount(db.client, "acc1", { key: "sub_1", draftWeek: true, ...deps, now: later });
    await again.settled;
    expect(topUp).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(6);
    expect(db.rows("workspaces")[0].trial_resumed_at).toEqual(expect.any(String));
  });

  it("does nothing for a site that is not owed this checkout", async () => {
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [{ ...site }] });
    const out = await resumeAccount(db.client, "acc1", { key: "sub_1", draftWeek: true, ...deps });
    expect(out.sites[0].skipped).toBe("not owed for this checkout");
    expect(topUp).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("runs the sites side by side, so one slow top-up does not hold another site's week", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    topUp.mockImplementation(async (...a: unknown[]) => {
      if (a[1] === "ws1") await gate;
      return [];
    });
    seq = 0;
    const second = { ...owed(), id: "ws2" };
    const db = new FakeDb({
      calendar_entries: [...calendar(), { ...entry("2026-09-26"), id: "e-ws2", workspace_id: "ws2" }],
      workspaces: [owed(), second],
    });
    const run = resumeAccount(db.client, "acc1", { key: "sub_1", draftWeek: true, ...deps });
    // ws2's week goes out while ws1's top-up is still running.
    await vi.waitFor(() => expect(sent.some((b) => b.workspaceId === "ws2")).toBe(true));
    expect(sent.some((b) => b.workspaceId === "ws1")).toBe(false);
    release();
    await (await run).settled;
    expect(sent.some((b) => b.workspaceId === "ws1")).toBe(true);
  });

  it("only tops up the month for a checkout without a trial: drafting keeps the scheduled pace", async () => {
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [{ ...site, trial_resume_key: "sub_2" }] });
    const out = await resumeAccount(db.client, "acc1", { key: "sub_2", draftWeek: false, ...deps });
    await out.settled;
    expect(topUp).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
    expect(db.rows("calendar_entries").every((e) => e.draft_owed_at === null)).toBe(true);
  });

  it("still starts the week when the top-up fails, and records the failure", async () => {
    topUp.mockRejectedValueOnce(new Error("provider timeout"));
    const db = new FakeDb({ calendar_entries: calendar(), workspaces: [owed()] });
    const out = await resumeAccount(db.client, "acc1", { key: "sub_1", draftWeek: true, ...deps });
    await out.settled;
    expect(out.sites[0].topUp).toBe("failed: provider timeout");
    expect(sent).toHaveLength(6);
    expect(events.some((e) => e.level === "warn" && String(e.message).includes("month top-up failed: provider timeout"))).toBe(true);
  });
});
