import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeDb } from "@/lib/plan/__tests__/fake-postgrest";

/**
 * /api/internal/draft: one draft per request, for the onboarding worker (the
 * first draft) and the trial resume (the rest of the week).
 *
 * Pinned here: only the secret opens it; a resumed entry is written only by
 * the request holding its claim, and a duplicate writes nothing; a failure is
 * written on the entry and the week moves on; the batch's email goes out when
 * the last draft lands; the first draft's email goes out from here, when the
 * run is stamped ready; and the trial hold stops anything past the first.
 */

const { generateArticle, getQuota, stampRun, announce, continueFrom, deferred } = vi.hoisted(() => ({
  generateArticle: vi.fn(),
  getQuota: vi.fn(),
  stampRun: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
  announce: vi.fn<(...a: unknown[]) => Promise<string>>(async () => "1 draft, emailed 1"),
  continueFrom: vi.fn(),
  deferred: [] as Array<() => unknown>,
}));

let db: FakeDb;
const order: string[] = [];

vi.mock("next/server", async () => {
  const real = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...real, after: (fn: () => unknown) => { deferred.push(fn); } };
});
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => db.client }));
vi.mock("@/lib/content/generate", () => ({ generateArticle: (...a: unknown[]) => generateArticle(...a) }));
vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: (...a: unknown[]) => getQuota(...a),
}));
vi.mock("@/lib/onboarding/run-store", () => ({
  stampRun: (...a: unknown[]) => (order.push(`stamp:${(a[2] as { status: string }).status}`), stampRun(...a)),
}));
vi.mock("@/lib/email/draft-batch", () => ({ announceDraftBatch: (...a: unknown[]) => (order.push("email"), announce(...a)) }));
vi.mock("@/lib/plan/resume-week", () => ({ continueFrom: (...a: unknown[]) => continueFrom(...a) }));
vi.mock("@/lib/onboarding/plan", () => ({
  fulfilPlannedEntry: async (_s: unknown, entryId: string, articleId: string) => {
    const row = db.rows("calendar_entries").find((e) => e.id === entryId);
    if (row) Object.assign(row, { article_id: articleId, status: "scheduled" });
  },
}));

import { POST } from "../draft/route";

function post(body: unknown, secret: string | null = "cron-secret") {
  return POST(
    new Request("https://app.example/api/internal/draft", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { "x-cron-secret": secret } : {}) },
      body: JSON.stringify(body),
    }) as never,
  );
}
async function runDeferred() {
  while (deferred.length) await deferred.shift()!();
}

const claimedEntry = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  workspace_id: "ws1",
  status: "queue",
  keyword: "crm for agencies",
  keyword_id: "k1",
  scheduled_date: "2026-09-26",
  article_id: null,
  draft_claimed_at: "2026-09-25T10:00:00.000Z",
  draft_claimed_by: "trial:sub_1",
  draft_failed_at: null,
  draft_failure: null,
  ...over,
});
const resumed = { workspaceId: "ws1", entryId: "e1", keywordId: "k1", keyword: "crm for agencies", claim: "trial:sub_1", until: "2026-09-30" };

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret";
  delete process.env.TRIAL_GATE_DISABLED;
  db = new FakeDb({ workspaces: [{ id: "ws1", account_id: "acc1" }], calendar_entries: [claimedEntry()] });
  order.length = 0;
  deferred.length = 0;
  generateArticle.mockReset().mockResolvedValue({ articleId: "art-9", title: "CRM for agencies", wordCount: 1200, factCheck: { verdict: "clean" } });
  // A trialing account: the plan, not the free allowance.
  getQuota.mockReset().mockResolvedValue({ limit: 100, used: 2, remaining: 98, reason: "plan", plan: "starter" });
  stampRun.mockClear();
  announce.mockClear();
  continueFrom.mockReset().mockResolvedValue({ started: 1, done: false, settled: Promise.resolve(), detail: "started 1" });
});

describe("auth", () => {
  it("refuses a request without the cron secret, or with the wrong one", async () => {
    expect((await post(resumed, null)).status).toBe(401);
    expect((await post(resumed, "guess")).status).toBe(401);
    expect(generateArticle).not.toHaveBeenCalled();
  });
  it("refuses an entry named without its claim", async () => {
    expect((await post({ ...resumed, claim: undefined })).status).toBe(400);
  });
});

describe("a resumed week's entry", () => {
  it("is written by the request holding its claim, linked, and the week's next draft is started", async () => {
    const res = await post(resumed);
    expect(res.status).toBe(200);
    expect(generateArticle).toHaveBeenCalledTimes(1);
    expect(generateArticle.mock.calls[0][0]).toMatchObject({ workspaceId: "ws1", keyword: "crm for agencies", keywordId: "k1", autonomous: true, billToAccountId: "acc1" });
    expect(db.rows("calendar_entries")[0]).toMatchObject({ article_id: "art-9" });

    await runDeferred();
    expect(continueFrom).toHaveBeenCalledWith(expect.anything(), "ws1", { by: "trial:sub_1", until: "2026-09-30" });
    // Others are still in flight: no email yet.
    expect(announce).not.toHaveBeenCalled();
  });

  it("sends the batch's one email when the last draft lands", async () => {
    continueFrom.mockResolvedValue({ started: 0, done: true, settled: Promise.resolve(), detail: "nothing left" });
    await post(resumed);
    await runDeferred();
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(expect.anything(), "ws1");
  });

  it("writes nothing for a duplicate: the claim is somebody else's, or the entry is already written", async () => {
    db.rows("calendar_entries")[0].draft_claimed_by = "cron:1";
    expect(await (await post(resumed)).json()).toEqual({ status: "skipped", reason: "not-claimed" });
    Object.assign(db.rows("calendar_entries")[0], { draft_claimed_by: "trial:sub_1", article_id: "art-1" });
    expect(await (await post(resumed)).json()).toEqual({ status: "skipped", reason: "not-claimed" });
    expect(generateArticle).not.toHaveBeenCalled();
    await runDeferred();
    expect(continueFrom).not.toHaveBeenCalled();
  });

  it("writes a failure on the entry, where the calendar and the next scheduled run find it, and moves the week on", async () => {
    generateArticle.mockRejectedValue(new Error("The model timed out."));
    const res = await post(resumed);
    expect(res.status).toBe(500);
    expect(db.rows("calendar_entries")[0]).toMatchObject({ draft_failure: "The model timed out.", article_id: null });
    expect(db.rows("calendar_entries")[0].draft_failed_at).toEqual(expect.any(String));
    await runDeferred();
    expect(continueFrom).toHaveBeenCalledTimes(1);
  });
});

describe("the onboarding run's first draft", () => {
  const first = { workspaceId: "ws1", runId: "run-1", keyword: "crm for agencies", keywordId: null };
  const gated = (used: number) => ({ limit: 7, used, remaining: 7 - used, reason: "no-plan", plan: null, trialEligible: true });

  it("is announced the moment the run is stamped ready, from this request", async () => {
    getQuota.mockResolvedValue(gated(0));
    const res = await post(first);
    expect(res.status).toBe(200);
    // Before the response, not in a deferred callback somebody may cut off.
    expect(order).toEqual(["stamp:done", "email"]);
    expect(announce).toHaveBeenCalledWith(expect.anything(), "ws1");
  });

  it("is still announced when the run was already closed: the draft is real either way", async () => {
    getQuota.mockResolvedValue(gated(0));
    stampRun.mockResolvedValueOnce(false);
    await post(first);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("is not announced when the draft failed", async () => {
    getQuota.mockResolvedValue(gated(0));
    generateArticle.mockRejectedValue(new Error("boom"));
    await post(first);
    expect(order).toEqual(["stamp:failed"]);
    expect(announce).not.toHaveBeenCalled();
  });

  it("holds anything past the first for a trial-gated account, and says why on the run", async () => {
    getQuota.mockResolvedValue(gated(1));
    const res = await post(first);
    expect(await res.json()).toEqual({ status: "skipped", reason: "trial-hold" });
    expect(generateArticle).not.toHaveBeenCalled();
    expect(stampRun.mock.calls[0][2]).toMatchObject({ phase: "drafting", status: "skipped", detail: expect.stringMatching(/^Waiting for your trial to start\./) });
  });
});
