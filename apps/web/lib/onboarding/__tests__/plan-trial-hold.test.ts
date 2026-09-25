import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeDb } from "@/lib/plan/__tests__/fake-postgrest";

/**
 * The planner owns the trial hold (lib/billing/trial-hold.ts): a gated
 * account's calendar holds its first article and nothing else, whoever asks
 * - onboarding, the nightly top-up, the Plan-month button, a resumed site, or
 * the research drawer. Every other account plans as it did.
 */

// The hold's own answer (open / held / spent) is lib/billing/trial-hold.ts's,
// read from the quota; this file tests what the planner does with it.
const { held, recs, recommended } = vi.hoisted(() => ({
  held: { value: "held" as "open" | "held" | "spent" },
  recs: [] as Array<Record<string, unknown>>,
  recommended: { calls: 0 },
}));
vi.mock("@/lib/billing/trial-hold", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/trial-hold")>()),
  planHold: async () => held.value,
  planHoldApplies: async () => held.value !== "open",
}));
vi.mock("@/lib/seo/recommendations", () => ({
  recommendKeywords: async () => {
    recommended.calls += 1;
    return recs;
  },
}));
vi.mock("@/lib/keywords/questions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/keywords/questions")>()),
  generateQualityQuestionsBatch: async () => new Map(),
}));
const { qualify } = vi.hoisted(() => ({ qualify: vi.fn() }));
vi.mock("@/lib/keyword-research/opportunity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/keyword-research/opportunity")>()),
  qualifyOpportunities: (...a: unknown[]) => qualify(...a),
}));

import { duePlannedKeyword, previewPlan, schedulePlan, scheduleKeywords } from "../plan";
import { TRIAL_HOLD_MESSAGE } from "@/lib/billing/trial-refusal";

const FROM = new Date("2026-09-24T09:00:00.000Z");
const rec = (i: number) => ({ keywordId: `k${i}`, term: `topic ${i}`, action: "write", quality: "ok", intent: "commercial" });

function db(entries: Array<Record<string, unknown>> = []) {
  return new FakeDb({
    calendar_entries: entries,
    keywords: Array.from({ length: 8 }, (_, i) => ({ id: `k${i}`, workspace_id: "ws1", term: `topic ${i}`, status: "new", plan_excluded_at: null })),
    workspaces: [{ id: "ws1", account_id: "acc1", auto_generate_weekly_limit: 7, business_profile: null, domain: "acme-agency.example", language: "en", location_code: 2840 }],
  });
}
const firstArticle = { id: "c0", workspace_id: "ws1", keyword_id: "k0", keyword: "topic 0", scheduled_date: "2026-09-24", status: "scheduled", article_id: "a0" };

beforeEach(() => {
  held.value = "held";
  recommended.calls = 0;
  recs.length = 0;
  recs.push(...Array.from({ length: 8 }, (_, i) => rec(i)));
  qualify.mockReset();
});

describe("the planner and the trial hold", () => {
  it("plans the first article only for a gated account at signup, whatever it is asked for", async () => {
    const d = db();
    const plan = await schedulePlan(d.client, "ws1", 7, { maxEntries: 5, from: FROM });
    expect(plan).toHaveLength(1);
    expect(d.rows("calendar_entries")).toHaveLength(1);
  });

  it("adds nothing on the nightly top-up, the Plan-month button or a resumed site once the first is planned", async () => {
    const d = db([firstArticle]);
    expect(await schedulePlan(d.client, "ws1", 7, { mode: "top-up", from: FROM })).toEqual([]);
    expect(await schedulePlan(d.client, "ws1", 7, { from: FROM })).toEqual([]);
    expect(d.rows("calendar_entries")).toHaveLength(1);
    expect((await previewPlan(d.client, "ws1", 7, { from: FROM })).next).toEqual([]);
  });

  it("plans the month for an account that is not held", async () => {
    held.value = "open";
    const d = db([firstArticle]);
    const added = await schedulePlan(d.client, "ws1", 7, { mode: "top-up", from: FROM });
    expect(added.length).toBeGreaterThan(1);
  });

  it("refuses a keyword picked from the research drawer, with the reason, rather than planning it for a writer that will not run", async () => {
    const d = db([firstArticle]);
    const out = await scheduleKeywords(d.client, "ws1", ["k3", "k4"], FROM);
    expect(out.scheduled).toEqual([]);
    expect(out.refused).toEqual(["k3", "k4"]);
    expect(out.reasons).toEqual({ k3: TRIAL_HOLD_MESSAGE, k4: TRIAL_HOLD_MESSAGE });
    expect(qualify).not.toHaveBeenCalled();
    expect(d.rows("calendar_entries")).toHaveLength(1);
  });

  it("plans nothing, and buys nothing, once the first article is attempted - even with the calendar emptied", async () => {
    // Round-4 review: the cap was counted from calendar entries, which a
    // client token can delete or mark done, and the nightly top-up then found
    // room for "the first article" again and bought qualification to fill it.
    held.value = "spent";
    const d = db([]);
    expect(await schedulePlan(d.client, "ws1", 7, { mode: "top-up", from: FROM })).toEqual([]);
    expect(await schedulePlan(d.client, "ws1", 7, { from: FROM })).toEqual([]);
    expect(recommended.calls).toBe(0);
    const out = await scheduleKeywords(d.client, "ws1", ["k3"], FROM);
    expect(out.scheduled).toEqual([]);
    expect(out.reasons).toEqual({ k3: TRIAL_HOLD_MESSAGE });
    expect(qualify).not.toHaveBeenCalled();
    expect(d.rows("calendar_entries")).toHaveLength(0);
  });
});

describe("duePlannedKeyword and claims", () => {
  const NOW = new Date("2026-09-25T10:00:00.000Z");
  const e = (id: string, over: Record<string, unknown>) => ({
    id, workspace_id: "ws1", status: "queue", article_id: null, keyword_id: `k-${id}`, keyword: `topic ${id}`,
    draft_claimed_at: null, draft_claimed_by: null, draft_failed_at: null, draft_failure: null, ...over,
  });

  it("does not hand the scheduled writer an entry somebody is writing right now", async () => {
    const d = new FakeDb({ calendar_entries: [e("a", { scheduled_date: "2026-09-25", draft_claimed_at: "2026-09-25T09:58:00.000Z", draft_claimed_by: "trial:sub_1" })] });
    expect(await duePlannedKeyword(d.client, "ws1", NOW)).toBeNull();
  });

  it("hands it a failed entry whatever its date, so what the trial resume could not write is not lost", async () => {
    const d = new FakeDb({ calendar_entries: [e("a", { scheduled_date: "2026-09-29", draft_claimed_at: "2026-09-25T09:00:00.000Z", draft_claimed_by: "trial:sub_1", draft_failed_at: "2026-09-25T09:03:00.000Z" })] });
    expect(await duePlannedKeyword(d.client, "ws1", NOW)).toMatchObject({ entryId: "a" });
  });

  it("hands it an entry whose writer died, once the claim's lease has run out", async () => {
    const d = new FakeDb({ calendar_entries: [e("a", { scheduled_date: "2026-09-29", draft_claimed_at: "2026-09-25T09:00:00.000Z", draft_claimed_by: "trial:sub_1" })] });
    expect(await duePlannedKeyword(d.client, "ws1", NOW)).toMatchObject({ entryId: "a" });
  });

  it("hands it an entry the trial start owes now whatever its date, once nobody is writing it", async () => {
    // The rest of the week the trial opened, whose chain of drafts was cut
    // off: owed, unclaimed, dated later this week.
    const owed = new FakeDb({ calendar_entries: [e("a", { scheduled_date: "2026-09-29", draft_owed_at: "2026-09-25T09:00:00.000Z" })] });
    expect(await duePlannedKeyword(owed.client, "ws1", NOW)).toMatchObject({ entryId: "a" });
    // Owed and being written right now: nobody else's.
    const writing = new FakeDb({
      calendar_entries: [e("a", { scheduled_date: "2026-09-29", draft_owed_at: "2026-09-25T09:00:00.000Z", draft_claimed_at: "2026-09-25T09:58:00.000Z", draft_claimed_by: "trial:sub_1" })],
    });
    expect(await duePlannedKeyword(writing.client, "ws1", NOW)).toBeNull();
  });

  it("leaves an unclaimed entry for its own day", async () => {
    const d = new FakeDb({ calendar_entries: [e("a", { scheduled_date: "2026-09-29" }), e("b", { scheduled_date: "2026-09-25" })] });
    expect(await duePlannedKeyword(d.client, "ws1", NOW)).toMatchObject({ entryId: "b" });
  });
});
