import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
/** When set, the run's budget is a stand-in whose room is its row's ceiling less this. */
const budgetFake = vi.hoisted(() => ({ committed: null as number | null }));

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
vi.mock("@/lib/billing/run-budget", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/billing/run-budget")>();
  return {
    ...real,
    loadDraftBudget: async (client: unknown, runId: string) => {
      if (budgetFake.committed === null) return real.loadDraftBudget(client as never, runId);
      const room = async () => Number(db.rows("run_budgets").find((r) => r.run_id === runId)?.ceiling_usd ?? 0) - budgetFake.committed!;
      return { runId, room, claim: async () => null, settle: async () => {} };
    },
  };
});
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
const resumed = { workspaceId: "ws1", entryId: "e1", keywordId: "k1", keyword: "crm for agencies", claim: "trial:sub_1" };

beforeEach(() => {
  budgetFake.committed = null;
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
    expect(continueFrom).toHaveBeenCalledWith(expect.anything(), "ws1", { by: "trial:sub_1" });
    // Others are still in flight: no email yet.
    expect(announce).not.toHaveBeenCalled();
  });

  it("sends the batch's one email when the last draft lands, that day even if the first draft's went out today", async () => {
    continueFrom.mockResolvedValue({ started: 0, done: true, settled: Promise.resolve(), detail: "nothing left" });
    await post(resumed);
    await runDeferred();
    expect(announce).toHaveBeenCalledTimes(1);
    // A trial started on signup day follows the first draft's email by
    // minutes; the once-a-day rule would hold the week until tomorrow.
    expect(announce).toHaveBeenCalledWith(expect.anything(), "ws1", { evenIfToldToday: true });
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

describe("a resumed week after the trial is cancelled before its first charge", () => {
  // The week's burst runs through here, one entry at a time; a person who
  // cancels mid-burst has the rest of it refused at its next step.
  const TRIAL_END = "2026-10-06T12:00:00.000Z";
  const trialing = (cancelsAt: string | null) => ({
    limit: 100, used: 5, remaining: 95, reason: "plan", plan: "starter",
    trial: { endsAt: TRIAL_END, daysLeft: 5, cancelsAt },
  });

  it("writes nothing, says why on the entry, and hands the week on so the chain reaches its end", async () => {
    getQuota.mockResolvedValue(trialing(TRIAL_END));
    const res = await post(resumed);
    expect(await res.json()).toEqual({ status: "skipped", reason: "trial-cancelled" });
    expect(generateArticle).not.toHaveBeenCalled();
    expect(db.rows("calendar_entries")[0]).toMatchObject({ draft_failure: expect.stringMatching(/^Your trial is cancelled, so nothing new is drafted\./), article_id: null });
    await runDeferred();
    expect(continueFrom).toHaveBeenCalledTimes(1);
  });

  it("writes the entry for a paid plan set to cancel at period end", async () => {
    getQuota.mockResolvedValue({ limit: 100, used: 40, remaining: 60, reason: "plan", plan: "starter", trial: null });
    await post(resumed);
    expect(generateArticle).toHaveBeenCalledTimes(1);
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

describe("a first look's draft, gated on its outline", () => {
  const first = { workspaceId: "ws1", runId: "run-1", keyword: "crm for agencies", keywordId: "k1" };
  const gated = (used: number) => ({ limit: 7, used, remaining: 7 - used, reason: "no-plan", plan: null, trialEligible: true });
  const OUTLINE = {
    version: 1, title: "CRM for agencies: what to look for", sections: ["Key takeaways", "What does a CRM do for an agency?", "How to choose one"],
    closing: "Learn more about Acme", targetWordCount: 1400, sources: ["https://research.example/crm"], model: "test", createdAt: "2026-10-11T00:00:00.000Z",
  };
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    db.rows("calendar_entries")[0] = claimedEntry({ draft_claimed_by: null, draft_claimed_at: null });
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
    sent.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    });
  });

  /** generateArticle as it behaves: outline stored, onReady awaited, then the body (or its failure). */
  const outlinedThen = (body: () => Promise<unknown>) => async (opts: { outline?: { onReady?: (r: unknown) => Promise<void> } }) => {
    order.push("outline");
    await opts.outline?.onReady?.({ articleId: "art-9", outline: OUTLINE });
    order.push("body");
    return body();
  };

  it("ends the run at the outline before the body is written, and emails only when the body lands", async () => {
    getQuota.mockResolvedValue(gated(0));
    generateArticle.mockImplementation(outlinedThen(async () => ({ articleId: "art-9", title: OUTLINE.title, wordCount: 1380, factCheck: { verdict: "clean" } })));
    const res = await post(first);
    expect(res.status).toBe(200);
    // The gate opens (the run finishes) between the outline and the body;
    // the body's sentence is laid over it after; then the one email.
    expect(order).toEqual(["outline", "stamp:done", "body", "stamp:done", "email"]);
    const [gate, written] = stampRun.mock.calls.map((c) => c[3] as { finish?: boolean; amend?: boolean; article?: Record<string, unknown> });
    expect(gate).toMatchObject({ finish: true, article: { id: "art-9", title: OUTLINE.title, wordCount: 1400, outlined: true } });
    expect(written).toMatchObject({ finish: true, amend: true });
    // On the calendar at the gate, so the card has its day.
    expect(db.rows("calendar_entries")[0]).toMatchObject({ article_id: "art-9" });
    expect(generateArticle.mock.calls[0][0]).toMatchObject({ outline: { keepOnFailure: true } });
  });

  /** The server's record of a body owed, as the gate's onOutline writes it. */
  const owedRow = (over: Record<string, unknown> = {}) => ({
    article_id: "art-9", workspace_id: "ws1", run_id: "run-1", keyword: "crm for agencies", keyword_id: "k1", outline: OUTLINE,
    attempts: 1, allowance_usd: 0, owed_since: new Date(Date.now() - 3_600_000).toISOString(), last_tried_at: new Date(Date.now() - 3_600_000).toISOString(), ...over,
  });

  it("records the body as owed when the gate opens, and clears it when the body lands", async () => {
    getQuota.mockResolvedValue(gated(0));
    let atGate: unknown[] = [];
    generateArticle.mockImplementation(async (opts: { outline?: { onReady?: (r: unknown) => Promise<void> } }) => {
      await opts.outline?.onReady?.({ articleId: "art-9", outline: OUTLINE });
      atGate = db.rows("owed_bodies").map((r) => ({ ...r }));
      return { articleId: "art-9", title: OUTLINE.title, wordCount: 1380, factCheck: { verdict: "clean" } };
    });
    await post(first);
    expect(atGate).toEqual([expect.objectContaining({ article_id: "art-9", workspace_id: "ws1", run_id: "run-1", keyword: "crm for agencies", keyword_id: "k1", outline: OUTLINE, attempts: 1 })]);
    expect(db.rows("owed_bodies")).toEqual([]);
  });

  it("keeps a body that fails after the gate owed, tries again in its own invocation, and never says setup failed", async () => {
    getQuota.mockResolvedValue(gated(0));
    generateArticle.mockImplementation(outlinedThen(async () => { throw new Error("The model timed out."); }));
    const res = await post(first);
    expect(await res.json()).toMatchObject({ status: "owed", attempt: 1 });
    expect(db.rows("owed_bodies")).toHaveLength(1);
    expect(order).not.toContain("stamp:failed");
    expect(announce).not.toHaveBeenCalled();
    await runDeferred();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://app.example/api/internal/draft");
    expect(sent[0].body).toMatchObject({ workspaceId: "ws1", runId: "run-1", articleId: "art-9", resume: true, attempt: 2, keyword: "crm for agencies" });
  });

  it("writes the owed body to the outline the server recorded, counting no second draft, and announces it", async () => {
    // The claim already counted the row: used is 1, and the hold still lets it through.
    getQuota.mockResolvedValue(gated(1));
    stampRun.mockResolvedValue(false);
    db.rows("owed_bodies").push(owedRow());
    // What the request says is not what is written: the record is.
    const res = await post({ ...first, keyword: "something the request made up", articleId: "art-9", resume: true, attempt: 2 });
    expect(res.status).toBe(200);
    expect(generateArticle.mock.calls[0][0]).toMatchObject({ articleId: "art-9", keyword: "crm for agencies", resumeOutline: OUTLINE });
    expect(generateArticle.mock.calls[0][0]).not.toHaveProperty("outline");
    expect(announce).toHaveBeenCalledTimes(1);
    expect(db.rows("owed_bodies")).toEqual([]);
  });

  it("writes nothing for a body nobody owes, however the request names it", async () => {
    getQuota.mockResolvedValue(gated(1));
    const res = await post({ ...first, articleId: "art-9", resume: true, attempt: 3 });
    expect(await res.json()).toEqual({ status: "skipped", reason: "not-owed" });
    // Another site's record is not this one's.
    db.rows("owed_bodies").push(owedRow({ workspace_id: "ws-other" }));
    expect(await (await post({ ...first, articleId: "art-9", resume: true })).json()).toEqual({ status: "skipped", reason: "not-owed" });
    expect(generateArticle).not.toHaveBeenCalled();
  });

  it("counts every try on the record and stops chaining at the third, leaving it to the nightly sweep", async () => {
    getQuota.mockResolvedValue(gated(1));
    db.rows("owed_bodies").push(owedRow({ attempts: 2 }));
    generateArticle.mockRejectedValue(new Error("still down"));
    const res = await post({ ...first, articleId: "art-9", resume: true, attempt: 1 });
    expect(await res.json()).toMatchObject({ status: "owed", attempt: 3 });
    expect(db.rows("owed_bodies")[0]).toMatchObject({ attempts: 3 });
    await runDeferred();
    expect(sent).toHaveLength(0);
    expect(order).not.toContain("stamp:failed");
  });

  it("gives a body up once its tries are spent: errored, the record gone, nothing written", async () => {
    getQuota.mockResolvedValue(gated(1));
    db.rows("articles").push({ id: "art-9", workspace_id: "ws1", status: "drafting" });
    db.rows("owed_bodies").push(owedRow({ attempts: 5 }));
    expect(await (await post({ ...first, articleId: "art-9", resume: true })).json()).toEqual({ status: "skipped", reason: "given-up" });
    expect(generateArticle).not.toHaveBeenCalled();
    expect(db.rows("articles").find((a) => a.id === "art-9")).toMatchObject({ status: "error" });
    expect(db.rows("owed_bodies")).toEqual([]);
  });

  it("pays an owed body from its run's budget, tops a short one up once, and gives it up past that", async () => {
    getQuota.mockResolvedValue(gated(1));
    db.rows("articles").push({ id: "art-9", workspace_id: "ws1", status: "drafting" });
    db.rows("run_budgets").push({ run_id: "run-1", ceiling_usd: 1 });
    db.rows("owed_bodies").push(owedRow());
    // A body billed and thrown away: $0.79 of the dollar spent, $0.21 left.
    budgetFake.committed = 0.79;
    generateArticle.mockRejectedValue(new Error("The draft did not follow its outline"));
    const first = await post({ workspaceId: "ws1", keyword: "crm for agencies", articleId: "art-9", resume: true });
    expect(await first.json()).toMatchObject({ status: "owed" });
    expect(generateArticle).toHaveBeenCalledTimes(1);
    // Under the run's budget, attributed to the run.
    expect(db.rows("run_budgets")[0].ceiling_usd).toBeCloseTo(1.12, 6);
    expect(db.rows("owed_bodies")[0]).toMatchObject({ allowance_usd: expect.closeTo(0.12, 6), attempts: 2 });

    // The top-up is spent too: the next try is given up, not written outside the budget.
    budgetFake.committed = 1.12;
    db.rows("owed_bodies")[0].last_tried_at = new Date(Date.now() - 3_600_000).toISOString();
    const second = await post({ workspaceId: "ws1", keyword: "crm for agencies", articleId: "art-9", resume: true });
    expect(await second.json()).toEqual({ status: "skipped", reason: "budget" });
    expect(generateArticle).toHaveBeenCalledTimes(1);
    expect(db.rows("articles").find((a) => a.id === "art-9")).toMatchObject({ status: "error" });
    expect(db.rows("owed_bodies")).toEqual([]);
  });

  it("clears the record without retrying when the article turns out not to be owed", async () => {
    getQuota.mockResolvedValue(gated(1));
    db.rows("owed_bodies").push(owedRow());
    const { OutlineNotOwedError } = await import("@/lib/content/outline");
    generateArticle.mockRejectedValue(new OutlineNotOwedError());
    expect(await (await post({ ...first, articleId: "art-9", resume: true })).json()).toEqual({ status: "skipped", reason: "not-owed" });
    await runDeferred();
    expect(sent).toHaveLength(0);
    expect(db.rows("owed_bodies")).toEqual([]);
  });

  it("waits for the body on an account with no gate, as before: the outline is progress, not the end", async () => {
    getQuota.mockResolvedValue({ limit: 100, used: 2, remaining: 98, reason: "plan", plan: "starter" });
    generateArticle.mockImplementation(outlinedThen(async () => ({ articleId: "art-9", title: OUTLINE.title, wordCount: 1380, factCheck: { verdict: "clean" } })));
    await post(first);
    expect(order).toEqual(["outline", "stamp:active", "body", "stamp:done", "email"]);
    expect(stampRun.mock.calls[0][3]).toBeUndefined();
    expect(generateArticle.mock.calls[0][0]).toMatchObject({ outline: { keepOnFailure: false } });
  });

  it("keeps the body as it is written for the gate's reader only with PRETRIAL_FULL_ARTICLE on (the default), and clears it when saved", async () => {
    db.rows("articles").push({ id: "art-9", workspace_id: "ws1", body_stream: null });
    getQuota.mockResolvedValue(gated(0));
    const streamingBody = outlinedThen(async () => ({ articleId: "art-9", title: OUTLINE.title, wordCount: 1380, factCheck: { verdict: "clean" } }));
    generateArticle.mockImplementation(async (opts: { outline?: { onReady?: (r: unknown) => Promise<void> }; onChunk?: (c: string) => void }) => {
      const run = streamingBody({ outline: { onReady: async (r) => { await opts.outline?.onReady?.(r); opts.onChunk?.("<p>first words</p>"); } } });
      return run;
    });
    process.env.PRETRIAL_FULL_ARTICLE = "1";
    try {
      await post(first);
    } finally {
      delete process.env.PRETRIAL_FULL_ARTICLE;
    }
    const streams = db.updates.filter((u) => u.table === "articles" && "body_stream" in u.patch).map((u) => u.patch.body_stream);
    expect(streams).toEqual(["<p>first words</p>", null]);
    // Beside it, the counts: thinking from the gate, writing from the first word, cleared when saved.
    const progress = db.updates.filter((u) => u.table === "articles" && "body_progress" in u.patch).map((u) => u.patch.body_progress as { stage: string; sections: number; words: number } | null);
    expect(progress.map((p) => p?.stage ?? null)).toEqual(["thinking", "writing", null]);
    expect(progress[1]).toMatchObject({ sections: 0, words: 2 });

    // Off: the text is never written, and the counts carry none of it.
    db.updates.length = 0;
    generateArticle.mockReset().mockImplementation(async (opts: { outline?: { onReady?: (r: unknown) => Promise<void> }; onChunk?: (c: string) => void; onWritten?: () => void }) =>
      outlinedThen(async () => ({ articleId: "art-9", title: OUTLINE.title, wordCount: 1380, factCheck: { verdict: "clean" } }))({
        outline: { onReady: async (r) => { await opts.outline?.onReady?.(r); opts.onChunk?.("<h2>Key takeaways</h2><p>secret words here</p><h2>Next</h2>"); opts.onWritten?.(); } },
      }),
    );
    process.env.PRETRIAL_FULL_ARTICLE = "0";
    try {
      await post(first);
    } finally {
      delete process.env.PRETRIAL_FULL_ARTICLE;
    }
    expect(db.updates.filter((u) => u.table === "articles" && "body_stream" in u.patch)).toEqual([]);
    const counts = db.updates.filter((u) => u.table === "articles" && "body_progress" in u.patch).map((u) => u.patch.body_progress);
    expect(counts.length).toBeGreaterThan(1);
    expect(counts.at(-1)).toBeNull();
    for (const c of counts.slice(0, -1)) expect(Object.keys(c as object).sort()).toEqual(["sections", "since", "stage", "v", "words"]);
    expect(JSON.stringify(counts)).not.toMatch(/secret|Key takeaways|Next/);
    expect(counts.map((c) => (c as { stage?: string } | null)?.stage ?? null)).toContain("finishing");
  });

  it("streams the text on its own when migration 108's column is missing, instead of losing it with the counts", async () => {
    db.rows("articles").push({ id: "art-9", workspace_id: "ws1", body_stream: null });
    getQuota.mockResolvedValue(gated(0));
    // The database as it is with the code deployed before 108: any update
    // that names body_progress fails whole.
    const real = (db as unknown as { query: (t: string) => Record<string, unknown> }).query.bind(db);
    let refused = 0;
    (db as unknown as { query: (t: string) => Record<string, unknown> }).query = (table: string) => {
      const q = real(table);
      if (table !== "articles") return q;
      const update = q.update as (p: Record<string, unknown>) => unknown;
      q.update = (p: Record<string, unknown>) => {
        if (!("body_progress" in p)) return update(p);
        refused++;
        return { eq: async () => ({ data: null, error: { code: "42703", message: "column articles.body_progress does not exist" } }) };
      };
      return q;
    };
    generateArticle.mockImplementation(async (opts: { outline?: { onReady?: (r: unknown) => Promise<void> }; onChunk?: (c: string) => void }) =>
      outlinedThen(async () => ({ articleId: "art-9", title: OUTLINE.title, wordCount: 1380, factCheck: { verdict: "clean" } }))({
        outline: { onReady: async (r) => { await opts.outline?.onReady?.(r); await new Promise((r2) => setTimeout(r2, 5)); opts.onChunk?.("<p>first words</p>"); } },
      }),
    );
    process.env.PRETRIAL_FULL_ARTICLE = "1";
    try {
      await post(first);
    } finally {
      delete process.env.PRETRIAL_FULL_ARTICLE;
    }
    // Tried once with the counts, then never again; the text still went out, and was cleared on save.
    expect(refused).toBe(1);
    const streams = db.updates.filter((u) => u.table === "articles" && "body_stream" in u.patch).map((u) => u.patch.body_stream);
    expect(streams).toEqual(["<p>first words</p>", null]);
  });

  it("an ungated body that fails is the run's failure, as before", async () => {
    getQuota.mockResolvedValue({ limit: 100, used: 2, remaining: 98, reason: "plan", plan: "starter" });
    generateArticle.mockImplementation(outlinedThen(async () => { throw new Error("boom"); }));
    const res = await post(first);
    expect(res.status).toBe(500);
    expect(order).toEqual(["outline", "stamp:active", "body", "stamp:failed"]);
    await runDeferred();
    expect(sent).toHaveLength(0);
  });
});
