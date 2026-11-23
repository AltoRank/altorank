import { describe, expect, it } from "vitest";
import {
  acquisitionRows,
  buildJourney,
  firstStepsByUser,
  funnelRows,
  isInternalEmail,
  outcomeReason,
  runOutcome,
  runOutcomeRows,
  signupsByDay,
  spanLabel,
  type FunnelRun,
  type Journey,
} from "../funnel";
import type { UserOrigin } from "../user-origin";

const chatgpt: UserOrigin = { kind: "campaign", label: "chatgpt.com", detail: null };
const unknown: UserOrigin = { kind: "unknown", label: "—", detail: "not recorded" };

const run = (over: Partial<FunnelRun> = {}): FunnelRun => ({
  account_id: "a1",
  status: "partial",
  started_at: "2026-11-16T06:13:23Z",
  finished_at: "2026-11-16T06:17:22Z",
  article_id: null,
  keywords_found: 23,
  phases: [
    { phase: "scanning", status: "done", detail: "Learned how your site writes." },
    { phase: "planning", status: "partial", detail: "Every search we checked is won by providers' own pages." },
  ],
  error: null,
  ...over,
});

const journey = (over: Partial<Parameters<typeof buildJourney>[0]> = {}): Journey =>
  buildJourney({
    user: { id: "u1", email: "owner@shop.com", createdAt: "2026-11-16T06:11:41Z" },
    origin: chatgpt,
    page: "/tools/backlink-checker/",
    account: { id: "a1", plan_status: "inactive", attribution_source: null },
    site: "shop.com",
    steps: undefined,
    runs: [],
    firstArticleAt: null,
    ...over,
  });

describe("firstStepsByUser", () => {
  it("keeps each user's first time at each step and skips rows without a user or a step", () => {
    const steps = firstStepsByUser([
      { created_at: "2026-11-16T06:12:20Z", context: { userId: "u1", step: "gate_shown" } },
      { created_at: "2026-11-16T06:12:10Z", context: { userId: "u1", step: "gate_shown" } },
      { created_at: "2026-11-16T06:12:11Z", context: { userId: "u2", step: "wizard_opened" } },
      { created_at: "2026-11-16T06:12:12Z", context: { step: "wizard_opened" } },
      { created_at: "2026-11-16T06:12:13Z", context: null },
    ]);
    expect(steps.get("u1")?.get("gate_shown")).toBe("2026-11-16T06:12:10Z");
    expect(steps.get("u2")?.size).toBe(1);
    expect(steps.size).toBe(2);
  });
});

describe("runOutcome", () => {
  it("names the phase that did not finish, and nothing for a run that wrote an article", () => {
    expect(runOutcome(run())).toBe("planning: Every search we checked is won by providers' own pages.");
    expect(runOutcome(run({ article_id: "art" }))).toBeNull();
    expect(runOutcome(run({ status: "running" }))).toBe("Still running");
    expect(runOutcome(run({ status: "error", error: "provider timed out", phases: [] }))).toBe("provider timed out");
    expect(runOutcome(run({ phases: [] }))).toBe("Finished partial with no article");
    expect(runOutcome(undefined)).toBeNull();
  });

  it("groups outcomes that differ only in their numbers", () => {
    expect(outcomeReason("keywords: 23 kept of 67")).toBe(outcomeReason("keywords: 15 kept of 19"));
  });
});

describe("buildJourney", () => {
  it("stops at signup when nothing else was recorded", () => {
    const j = journey();
    expect(j.furthest).toBe("signed_up");
    expect(j.at).toEqual({ signed_up: "2026-11-16T06:11:41Z" });
    expect(j.runOutcome).toBeNull();
  });

  it("reads a run that planned nothing as started, not written, and says why", () => {
    const j = journey({
      steps: new Map([
        ["wizard_opened", "2026-11-16T06:12:10Z"],
        ["site_read_finished", "2026-11-16T06:12:20Z"],
      ]),
      runs: [run()],
    });
    expect(j.furthest).toBe("run_started");
    expect(j.at.run_started).toBe("2026-11-16T06:13:23Z");
    expect(j.at.draft_written).toBeUndefined();
    expect(j.runOutcome).toMatch(/^planning:/);
    expect(j.runs).toBe(1);
  });

  it("counts a draft the nightly cron wrote after a failed run", () => {
    const j = journey({ runs: [run()], firstArticleAt: "2026-11-17T02:00:00Z" });
    expect(j.at.draft_written).toBe("2026-11-17T02:00:00Z");
    expect(j.runOutcome).toBeNull();
  });

  it("takes trial and paid from the plan Stripe mirrored when no step says so", () => {
    expect(journey({ account: { id: "a1", plan_status: "trialing", attribution_source: null } }).furthest).toBe("trial_started");
    const paid = journey({ account: { id: "a1", plan_status: "active", attribution_source: "ai" } });
    expect(paid.furthest).toBe("paid");
    expect(paid.declared).toBe("ai");
  });
});

describe("funnelRows", () => {
  it("counts each stage's own rows, the share of the stage before, and where journeys end", () => {
    const gate = journey({
      user: { id: "u2", email: "b@b.com", createdAt: "2026-11-16T07:00:00Z" },
      steps: new Map([
        ["wizard_opened", "2026-11-16T07:00:30Z"],
        ["gate_shown", "2026-11-16T07:10:00Z"],
      ]),
      runs: [run({ article_id: "art", started_at: "2026-11-16T07:01:00Z", finished_at: "2026-11-16T07:06:00Z" })],
    });
    const rows = funnelRows([journey(), gate]);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.signed_up).toMatchObject({ reached: 2, ofCohort: 1, ofPrevious: null, stoppedHere: 1 });
    expect(by.wizard_opened).toMatchObject({ reached: 1, ofCohort: 0.5, ofPrevious: 0.5 });
    expect(by.gate_shown).toMatchObject({ reached: 1, stoppedHere: 1, medianMinutes: 10 });
    expect(by.trial_started).toMatchObject({ reached: 0, ofPrevious: 0 });
    expect(rows.reduce((n, r) => n + r.stoppedHere, 0)).toBe(2);
  });

  it("is all zeros for an empty cohort", () => {
    expect(funnelRows([]).every((r) => r.reached === 0 && r.ofCohort === 0)).toBe(true);
  });
});

describe("runOutcomeRows", () => {
  it("groups the sites each reason stranded, most common first", () => {
    const rows = runOutcomeRows([
      journey({ runs: [run()], site: "a.com" }),
      journey({ runs: [run()], site: "b.com" }),
      journey({ runs: [run({ phases: [{ phase: "scanning", status: "skipped", detail: "Too little readable text." }] })], site: "c.com" }),
      journey(),
    ]);
    expect(rows.map((r) => [r.users, r.sites])).toEqual([
      [2, ["a.com", "b.com"]],
      [1, ["c.com"]],
    ]);
  });
});

describe("acquisitionRows", () => {
  it("groups by source, page and declared channel, with the unrecorded row last", () => {
    const journeys = [
      journey(),
      journey({ runs: [run({ article_id: "art" })], steps: new Map([["gate_shown", "2026-11-16T06:20:00Z"]]) }),
      journey({ origin: unknown, page: null }),
    ];
    expect(acquisitionRows(journeys, "source")).toEqual([
      { value: "chatgpt.com", signups: 2, drafts: 1, gate: 1, trialClicks: 0, trials: 0, paid: 0 },
      { value: "Not recorded", signups: 1, drafts: 0, gate: 0, trialClicks: 0, trials: 0, paid: 0 },
    ]);
    expect(acquisitionRows(journeys, "page").map((r) => r.value)).toEqual(["/tools/backlink-checker/", "No page on the link"]);
    expect(acquisitionRows(journeys, "declared")).toHaveLength(1);
  });
});

describe("signupsByDay", () => {
  it("fills the empty days of the window", () => {
    const days = signupsByDay([journey(), journey()], 3, new Date("2026-11-17T12:00:00Z"));
    expect(days).toEqual([
      { day: "2026-11-15", n: 0 },
      { day: "2026-11-16", n: 2 },
      { day: "2026-11-17", n: 0 },
    ]);
  });
});

describe("labels", () => {
  it("reads spans and internal addresses", () => {
    expect([spanLabel(null), spanLabel(0.2), spanLabel(12), spanLabel(180), spanLabel(4320)]).toEqual(["—", "< 1 min", "12 min", "3 h", "3 d"]);
    expect(isInternalEmail("hello@altorank.co")).toBe(true);
    expect(isInternalEmail("owner+test@shop.com")).toBe(true);
    expect(isInternalEmail("owner@shop.com")).toBe(false);
  });
});
