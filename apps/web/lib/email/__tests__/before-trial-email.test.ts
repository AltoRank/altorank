/**
 * The draft mail to an account that has not started its trial.
 *
 * Nothing it could click shows the text before the trial (lib/billing/trial.ts,
 * draftBodyLocked), so the mail must not say "Read the draft" or link one: it
 * says the article is written, what the trial opens, and links the setup
 * screen that shows the article's outline. A paying account's mail is
 * unchanged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { sendTransactionalEmail } = vi.hoisted(() => ({ sendTransactionalEmail: vi.fn() }));
vi.mock("../resend", () => ({ sendTransactionalEmail }));

let gate: "open" | "gated" | "bypassed" = "gated";
const accountTrialGate = vi.fn(async () => gate);
vi.mock("@/lib/billing/body-lock", () => ({ accountTrialGate: () => accountTrialGate() }));

import { renderArticleDrafted } from "../article-emails";
import { announceDraftBatch, renderDraftBatch, SETTLE_MS } from "../draft-batch";
import { fakeDraftDb } from "./fake-draft-db";

beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "a-test-secret";
});
afterAll(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
});
beforeEach(() => {
  gate = "gated";
  accountTrialGate.mockClear();
  sendTransactionalEmail.mockReset();
  sendTransactionalEmail.mockResolvedValue(undefined);
});

const ONE = {
  domain: "acme-agency.example",
  keyword: "ajans rehberi",
  title: "Ajanslar için rehber",
  wordCount: 1840,
  verdict: "clean" as const,
  reasons: ["Buyers search it weekly"],
  articleId: "a1",
};

describe("renderArticleDrafted, before the trial", () => {
  it("links the setup screen, not the draft, and does not promise reading it", () => {
    const r = renderArticleDrafted({ ...ONE, beforeTrial: true });
    expect(r.html).not.toContain("/content/");
    expect(r.html).toContain("https://app.example/onboarding");
    expect(r.html).not.toMatch(/Read the draft/i);
    expect(r.html).toContain("The full text opens when your 7-day trial starts");
    expect(r.subject).toBe("Your first article for acme-agency.example is written");
    expect(r.preheader).toContain("Start your 7-day trial to read it");
  });

  it("is unchanged for a paying account", () => {
    const r = renderArticleDrafted(ONE);
    expect(r.html).toContain("/content/a1");
    expect(r.html).toContain("Read the draft");
  });
});

describe("renderDraftBatch, before the trial", () => {
  const batch = {
    domain: "acme-agency.example",
    total: 2,
    drafts: [
      { articleId: "a1", title: "Birinci", keyword: "k1", wordCount: 1000, verdict: "clean" as const },
      { articleId: "a2", title: "İkinci", keyword: "k2", wordCount: 900, verdict: "review" as const },
    ],
  };

  it("names the titles without linking them, and points at the trial", () => {
    const r = renderDraftBatch({ ...batch, beforeTrial: true });
    expect(r.html).toContain("Birinci");
    expect(r.html).not.toContain("/content/");
    expect(r.html).not.toContain("/articles?status=review");
    expect(r.html).toContain("https://app.example/onboarding");
    expect(r.html).not.toMatch(/ready to read/i);
  });
});

describe("announceDraftBatch asks the gate", () => {
  const NOW = new Date("2026-09-25T09:00:00.000Z");
  const WRITTEN_AT = new Date(NOW.getTime() - SETTLE_MS - 60_000).toISOString();
  const db = () =>
    fakeDraftDb({
      workspaces: [{ id: "ws1", account_id: "acc1", domain: "acme-agency.example", auto_approve: false, auto_approve_hold_hours: 24 }],
      account_members: [{ account_id: "acc1", user_id: "u1", workspace_ids: null }],
      emails: { u1: "owner@acme-agency.example" },
      articles: [
        { id: "a1", workspace_id: "ws1", status: "review", title: "Ajanslar için rehber", keyword: "ajans rehberi", keyword_id: null, word_count: 1840, fact_check_verdict: "clean", created_at: WRITTEN_AT, auto_approve_after: null },
      ],
      keywords: [],
    });

  it("sends the before-trial mail to a gated account", async () => {
    const d = db();
    await announceDraftBatch(d.client, "ws1", { now: NOW });
    expect(accountTrialGate).toHaveBeenCalled();
    const html = sendTransactionalEmail.mock.calls[0]![2] as string;
    expect(html).not.toContain("/content/");
    expect(html).toContain("/onboarding");
  });

  it("sends the usual mail to an open account", async () => {
    gate = "open";
    const d = db();
    await announceDraftBatch(d.client, "ws1", { now: NOW });
    const html = sendTransactionalEmail.mock.calls[0]![2] as string;
    expect(html).toContain("/content/a1");
  });

  it("holds the mail back when the gate cannot be read, rather than guessing", async () => {
    accountTrialGate.mockRejectedValueOnce(new Error("quota: could not read"));
    const d = db();
    const line = await announceDraftBatch(d.client, "ws1", { now: NOW });
    expect(line).toMatch(/digest failed/);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });
});
