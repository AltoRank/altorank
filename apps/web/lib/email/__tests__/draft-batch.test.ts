import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const { sendTransactionalEmail } = vi.hoisted(() => ({ sendTransactionalEmail: vi.fn() }));
vi.mock("../resend", () => ({ sendTransactionalEmail }));

import {
  announceDraftBatch,
  renderDraftBatch,
  sweepUnannouncedDrafts,
  MAX_LISTED,
  SETTLE_MS,
} from "../draft-batch";
import { fakeDraftDb } from "./fake-draft-db";

beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "a-test-secret";
});
afterAll(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
});

beforeEach(() => {
  sendTransactionalEmail.mockReset();
  sendTransactionalEmail.mockResolvedValue(undefined);
});

const NOW = new Date("2026-09-08T09:00:00.000Z");
/** Past SETTLE_MS, so the sweep will look at it too. */
const WRITTEN_AT = new Date(NOW.getTime() - SETTLE_MS - 60_000).toISOString();

const draft = (i: number, over: Record<string, unknown> = {}) => ({
  id: `a${i}`,
  workspace_id: "ws1",
  status: "review",
  title: `Draft number ${i}`,
  keyword: `keyword ${i}`,
  keyword_id: `k${i}`,
  word_count: 1000 + i,
  fact_check_verdict: "clean",
  created_at: WRITTEN_AT,
  auto_approve_after: null,
  ...over,
});

function db(over: Parameters<typeof fakeDraftDb>[0] = {}) {
  return fakeDraftDb({
    workspaces: [
      { id: "ws1", agency_id: "ag1", domain: "example.test", auto_approve: false, auto_approve_hold_hours: 24 },
    ],
    agency_members: [{ agency_id: "ag1", user_id: "u1", workspace_ids: null }],
    emails: { u1: "owner@example.test" },
    articles: [draft(1), draft(2), draft(3)],
    keywords: [
      { id: "k1", volume: 1000, difficulty: 12 },
      { id: "k2", volume: 2000, difficulty: null },
      { id: "k3", volume: null, difficulty: null },
    ],
    ...over,
  });
}

const BATCH = {
  domain: "example.test",
  total: 3,
  drafts: [
    { articleId: "a1", title: "How to hire", keyword: "hire a dev", wordCount: 1400, verdict: "clean" as const, volume: 27100 },
    { articleId: "a2", title: "Second one", keyword: "second kw", wordCount: 1200, verdict: "review" as const, volume: 900 },
    { articleId: "a3", title: "Third one", keyword: "third kw", wordCount: 900, verdict: "clean" as const, volume: null },
  ],
};

describe("renderDraftBatch", () => {
  it("is one email about all of them, naming each draft and its keyword", () => {
    const r = renderDraftBatch(BATCH);
    expect(r.subject).toBe("3 drafts are ready for example.test");
    expect(r.html).toContain("How to hire");
    expect(r.html).toContain("Second one");
    expect(r.html).toContain("Third one");
    expect(r.html).toContain("hire a dev");
    // Each title links to the draft, at the route that exists.
    expect(r.html).toContain("https://app.altorank.co/content/a1");
    // And one primary action, at the queue rather than at one article.
    expect(r.html).toContain("https://app.altorank.co/articles?status=review");
  });

  /**
   * The promise the whole product rests on, in the mail that arrives before
   * anybody has opened the dashboard.
   */
  it("says nothing publishes without approval", () => {
    expect(renderDraftBatch(BATCH).html).toContain("Nothing publishes until you approve them");
  });

  it("gives the deadline instead when the workspace publishes on its own", () => {
    const r = renderDraftBatch({ ...BATCH, autoApproveAfter: "2026-09-09T21:09:00.000Z" });
    // Not the month name: Node's ICU says "Sept" where a browser may say "Sep".
    expect(r.html).toContain("2026, 21:09 UTC");
    expect(r.html).toContain("unless you hold them");
    expect(r.html).not.toContain("Nothing publishes until");
    expect(r.preheader).toContain("publishing on their own");
  });

  /** The one verdict whose reader has a different job gets said in the subject. */
  it("escalates the subject when a figure has no source", () => {
    const risky = renderDraftBatch({
      ...BATCH,
      drafts: [{ ...BATCH.drafts[0]!, verdict: "high_risk" as const }, BATCH.drafts[1]!],
    });
    expect(risky.subject).toBe("3 drafts for example.test, one with a figure to confirm");
    expect(risky.html).toContain("Unsourced figure");
  });

  it("adds up the words and the searches, and leaves searches out when nothing measured any", () => {
    expect(renderDraftBatch(BATCH).html).toContain("28,000");
    const r = renderDraftBatch({
      ...BATCH,
      drafts: BATCH.drafts.map((d) => ({ ...d, volume: null })),
    });
    // Never a zero standing in for "nobody looked".
    expect(r.html).not.toContain("SEARCHES");
    expect(r.html).not.toContain("Searches");
  });

  it("escapes every title and keyword, all of them model output", () => {
    const r = renderDraftBatch({
      ...BATCH,
      domain: "<b>evil</b>.co",
      drafts: [{ ...BATCH.drafts[0]!, title: "<script>alert(1)</script>", keyword: 'x" onmouseover="alert(1)' }],
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain('onmouseover="alert(1)"');
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("counts the overflow rather than listing forty rows", () => {
    const many = Array.from({ length: MAX_LISTED + 5 }, (_, i) => ({ ...BATCH.drafts[0]!, articleId: `x${i}`, title: `T${i}` }));
    const r = renderDraftBatch({ ...BATCH, total: many.length, drafts: many });
    expect(r.html).toContain("and 5 more");
    expect(r.html).not.toContain(`T${MAX_LISTED + 1}`);
  });

  it("says how to publish when there is nowhere to publish to, and stays quiet otherwise", () => {
    expect(renderDraftBatch({ ...BATCH, cmsConnected: false }).html).toContain("Nothing is connected to publish to yet");
    expect(renderDraftBatch({ ...BATCH, cmsConnected: true }).html).not.toContain("Nothing is connected");
    expect(renderDraftBatch(BATCH).html).not.toContain("Nothing is connected");
  });

  it("carries no image, so nothing is blocked or tracked", () => {
    expect(renderDraftBatch(BATCH).html).not.toContain("<img");
  });
});

describe("announceDraftBatch", () => {
  it("sends one email for a batch, not one per draft", async () => {
    const d = db();
    const line = await announceDraftBatch(d.client, "ws1", { now: NOW });
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(sendTransactionalEmail.mock.calls[0]![0]).toBe("owner@example.test");
    expect(sendTransactionalEmail.mock.calls[0]![1]).toBe("3 drafts are ready for example.test");
    expect(line).toContain("3 drafts");
  });

  /** The whole point of a fan-out: seven concurrent writers, one announcement. */
  it("says nothing at all on a second run", async () => {
    const d = db();
    await announceDraftBatch(d.client, "ws1", { now: NOW });
    sendTransactionalEmail.mockClear();
    const line = await announceDraftBatch(d.client, "ws1", { now: NOW });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
    expect(line).toBe("no drafts to announce");
  });

  /**
   * The digest claims `article_drafted` for each article it listed, so the
   * daily cron cannot announce the same draft a second time on its own.
   */
  it("marks every listed draft as announced", async () => {
    const d = db();
    await announceDraftBatch(d.client, "ws1", { now: NOW });
    for (const id of ["a1", "a2", "a3"]) {
      expect(d.claims.has(`article_drafted|${id}|owner@example.test`)).toBe(true);
    }
  });

  it("leaves a draft the cron already announced out of the digest", async () => {
    const d = db({
      sent_emails: [
        { email_type: "article_drafted", subject_id: "a1", recipient: "owner@example.test", agency_id: "ag1", workspace_id: "ws1" },
      ],
    });
    await announceDraftBatch(d.client, "ws1", { now: NOW });
    const html = sendTransactionalEmail.mock.calls[0]![2] as string;
    expect(html).toContain("Draft number 2");
    expect(html).not.toContain("Draft number 1");
    expect(sendTransactionalEmail.mock.calls[0]![1]).toBe("2 drafts are ready for example.test");
  });

  it("sends nothing to an address that unsubscribed from drafts", async () => {
    const d = db({ preferences: { "owner@example.test": ["drafts"] } });
    const line = await announceDraftBatch(d.client, "ws1", { now: NOW });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
    expect(line).toContain("already told or opted out");
  });

  it("carries the unsubscribe link and the one-click headers", async () => {
    const d = db();
    await announceDraftBatch(d.client, "ws1", { now: NOW });
    const opts = sendTransactionalEmail.mock.calls[0]![5] as {
      headers?: Record<string, string>;
      unsubscribeUrl?: string | null;
    };
    expect(opts.unsubscribeUrl).toContain("c=drafts");
    expect(opts.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  /**
   * A provider that refused must not cost the account its only notification:
   * nothing is marked announced, so the next pass tries the same batch again.
   */
  it("claims nothing when the send failed, so the sweep can retry", async () => {
    const d = db();
    sendTransactionalEmail.mockRejectedValueOnce(new Error("Resend refused the email"));
    const line = await announceDraftBatch(d.client, "ws1", { now: NOW });
    expect(line).toContain("failed");
    expect(d.claims.has("article_drafted|a1|owner@example.test")).toBe(false);

    sendTransactionalEmail.mockResolvedValue(undefined);
    await announceDraftBatch(d.client, "ws1", { now: NOW });
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2);
  });

  it("falls back to the single-draft email when only one draft is new", async () => {
    const d = db({ articles: [draft(1)], keywords: [{ id: "k1", volume: 27100, difficulty: 19 }] });
    await announceDraftBatch(d.client, "ws1", { now: NOW });
    expect(sendTransactionalEmail.mock.calls[0]![1]).toBe('New draft for example.test: "keyword 1"');
    // And that path claims the article itself, so it cannot be digested later.
    expect(d.claims.has("article_drafted|a1|owner@example.test")).toBe(true);
  });

  it("does not email a workspace nobody is a member of", async () => {
    const d = db({ agency_members: [] });
    expect(await announceDraftBatch(d.client, "ws1", { now: NOW })).toBe("nobody to email");
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it("never throws when the workspace is gone", async () => {
    const d = db({ workspaces: [] });
    expect(await announceDraftBatch(d.client, "ws1", { now: NOW })).toBe("workspace not found");
  });

  it("says a site has nowhere to publish to only when that is true", async () => {
    const bare = db();
    await announceDraftBatch(bare.client, "ws1", { now: NOW });
    expect(sendTransactionalEmail.mock.calls[0]![2]).toContain("Nothing is connected to publish to yet");

    sendTransactionalEmail.mockClear();
    const wired = db({
      workspace_integrations: [
        { id: "wi1", workspace_id: "ws1", config: { type: "wordpress" }, publish_mode: "publish", integration: { id: "wordpress", name: "WordPress", tag: "CMS" } },
      ],
    });
    await announceDraftBatch(wired.client, "ws1", { now: NOW });
    expect(sendTransactionalEmail.mock.calls[0]![2]).not.toContain("Nothing is connected");
  });

  /**
   * The hold window is what makes "you saw it first" true, so it starts when
   * this mail goes out - not when a fan-out wrote the draft minutes earlier
   * and told nobody.
   */
  it("starts the hold window on the drafts it announces, when the site publishes automatically", async () => {
    const d = db({
      workspaces: [{ id: "ws1", agency_id: "ag1", domain: "example.test", auto_approve: true, auto_approve_hold_hours: 24 }],
    });
    await announceDraftBatch(d.client, "ws1", { now: NOW });
    const stamped = d.tables.articles.map((a) => a.auto_approve_after);
    expect(stamped.every((s) => s === "2026-09-09T09:00:00.000Z")).toBe(true);
    expect(sendTransactionalEmail.mock.calls[0]![2]).toContain("2026, 09:00 UTC");
  });

  it("leaves a hold window somebody may already be watching alone", async () => {
    const d = db({
      workspaces: [{ id: "ws1", agency_id: "ag1", domain: "example.test", auto_approve: true, auto_approve_hold_hours: 24 }],
      articles: [draft(1, { auto_approve_after: "2026-09-08T12:00:00.000Z" }), draft(2)],
    });
    await announceDraftBatch(d.client, "ws1", { now: NOW });
    expect(d.tables.articles[0]!.auto_approve_after).toBe("2026-09-08T12:00:00.000Z");
    expect(sendTransactionalEmail.mock.calls[0]![2]).toContain("2026, 12:00 UTC");
  });
});

describe("sweepUnannouncedDrafts", () => {
  it("finds a workspace whose fan-out never got to announce itself", async () => {
    const d = db();
    const lines = await sweepUnannouncedDrafts(d.client, NOW);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(["ws1: 3 drafts, emailed 1"]);
  });

  it("reports nothing once every draft has been announced", async () => {
    const d = db();
    await sweepUnannouncedDrafts(d.client, NOW);
    sendTransactionalEmail.mockClear();
    expect(await sweepUnannouncedDrafts(d.client, NOW)).toEqual([]);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  /** A fan-out still in flight must not be split across two emails. */
  it("leaves a draft written moments ago for the run that is writing it", async () => {
    const d = db({
      articles: [draft(1), draft(2), draft(3, { created_at: new Date(NOW.getTime() - 60_000).toISOString() })],
    });
    await sweepUnannouncedDrafts(d.client, NOW);
    const html = sendTransactionalEmail.mock.calls[0]![2] as string;
    expect(html).toContain("Draft number 2");
    expect(html).not.toContain("Draft number 3");
  });
});
