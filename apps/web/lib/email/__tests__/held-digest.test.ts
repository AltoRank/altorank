import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";

vi.mock("../resend", () => ({ sendTransactionalEmail: vi.fn() }));
vi.mock("@/lib/observability/record", () => ({ recordEvent: vi.fn() }));
// The trial gate as the account's mail sees it (asked as nobody). The real
// predicate against a real account is in trial-cancel-and-gate.db.test.ts.
const { gate, accountTrialGate } = vi.hoisted(() => {
  const gate = { value: "open" as "open" | "gated" | "bypassed" };
  return { gate, accountTrialGate: vi.fn(async (..._a: unknown[]) => gate.value) };
});
vi.mock("@/lib/billing/body-lock", () => ({ accountTrialGate: (...a: unknown[]) => accountTrialGate(...a) }));

import { sendTransactionalEmail } from "../resend";
import { fakeDraftDb } from "./fake-draft-db";
import { GATED_DIGEST_LINE, HOLD_REMINDER_AFTER_MS, HOLD_WINDOW_RESET_MS, holdDigestSlot, sendHeldDigests } from "../held-digest";
import type { AutoApproveResult } from "@/lib/publishing/auto-approve";

const send = vi.mocked(sendTransactionalEmail);
const NOW = new Date("2026-09-17T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
afterAll(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
});
beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue(undefined);
  gate.value = "open";
  accountTrialGate.mockClear();
});

const held = (id: string): AutoApproveResult =>
  ({ workspaceId: "ws1", articleId: id, outcome: "held", detail: "score 40 is under the floor of 60" }) as AutoApproveResult;

function db(sent: Record<string, unknown>[] = []) {
  return fakeDraftDb({
    workspaces: [{ id: "ws1", account_id: "ag1", domain: "packhub.test", auto_approve: true, auto_approve_hold_hours: 24 }],
    account_members: [{ account_id: "ag1", user_id: "u1", workspace_ids: null }],
    emails: { u1: "owner@packhub.test" },
    articles: [{ id: "a1", workspace_id: "ws1", status: "review", title: "Held one" }],
    sent_emails: sent,
  });
}

const row = (subject_id: string, sent_at: string) => ({
  email_type: "auto_approve_held",
  subject_id,
  recipient: "owner@packhub.test",
  workspace_id: "ws1",
  sent_at,
});

describe("holdDigestSlot", () => {
  it("opens a window when the ledger is empty", async () => {
    expect(await holdDigestSlot(db().client, "ws1", NOW)).toEqual({ kind: "opener", subjectId: "ws1:hold:2026-09-17" });
  });

  it("says nothing the day after the opener", async () => {
    const slot = await holdDigestSlot(db([row("ws1:hold:2026-09-16", ago(DAY))]).client, "ws1", NOW);
    expect(slot.kind).toBe("skip");
  });

  it("reminds once the opener is three days old, keyed on the opener", async () => {
    const slot = await holdDigestSlot(db([row("ws1:hold:2026-09-14", ago(HOLD_REMINDER_AFTER_MS))]).client, "ws1", NOW);
    expect(slot).toEqual({ kind: "reminder", subjectId: "ws1:hold:2026-09-14:reminder" });
  });

  it("treats a legacy per-day key as the opener", async () => {
    const slot = await holdDigestSlot(db([row("ws1:2026-09-14", ago(3 * DAY))]).client, "ws1", NOW);
    expect(slot).toEqual({ kind: "reminder", subjectId: "ws1:2026-09-14:reminder" });
  });

  it("never reminds twice in one window", async () => {
    const d = db([row("ws1:hold:2026-09-01", ago(10 * DAY)), row("ws1:hold:2026-09-01:reminder", ago(7 * DAY))]);
    expect((await holdDigestSlot(d.client, "ws1", NOW)).kind).toBe("skip");
  });

  it("opens a new window once the ledger has been quiet long enough", async () => {
    const d = db([row("ws1:hold:2026-08-01:reminder", ago(HOLD_WINDOW_RESET_MS))]);
    expect(await holdDigestSlot(d.client, "ws1", NOW)).toEqual({ kind: "opener", subjectId: "ws1:hold:2026-09-17" });
  });
});

describe("sendHeldDigests", () => {
  it("sends the opener once and not again the next morning", async () => {
    const d = db();
    expect(await sendHeldDigests(d.client, [held("a1")], NOW)).toEqual(["ws1: 1 held, opener, emailed 1"]);
    // The fake ledger stamps no sent_at; stamp it as Postgres would.
    d.tables.sent_emails[0]!.sent_at = NOW.toISOString();
    const tomorrow = new Date(NOW.getTime() + DAY);
    expect(await sendHeldDigests(d.client, [held("a1")], tomorrow)).toEqual(["ws1: 1 held, told 1 day(s) ago, reminder waits"]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends the reminder with the same template", async () => {
    const d = db([row("ws1:hold:2026-09-14", ago(3 * DAY))]);
    expect(await sendHeldDigests(d.client, [held("a1")], NOW)).toEqual(["ws1: 1 held, reminder, emailed 1"]);
    expect(send.mock.calls[0]![1]).toContain("not published automatically");
  });
});

describe("sendHeldDigests and an account that has not started its trial", () => {
  // Every draft of such an account is held for "no active plan", and the
  // email links a queue and drafts the account cannot open. One real account
  // received every one of these the product had sent (assessment 2026-09-29).
  it("sends nothing, writes nothing to the ledger, and says why in the run", async () => {
    gate.value = "gated";
    const d = db();
    expect(await sendHeldDigests(d.client, [held("a1")], NOW)).toEqual([`ws1: 1 held, ${GATED_DIGEST_LINE}`]);
    expect(send).not.toHaveBeenCalled();
    expect(d.tables.sent_emails).toHaveLength(0);
    // Asked about the site's account, as nobody: a mail goes to every member.
    expect(accountTrialGate).toHaveBeenCalledWith(expect.anything(), "ag1", null);
  });

  it("opens a fresh window once the trial starts: nothing was spent while it was gated", async () => {
    gate.value = "gated";
    const d = db();
    await sendHeldDigests(d.client, [held("a1")], NOW);
    gate.value = "open";
    expect(await sendHeldDigests(d.client, [held("a1")], NOW)).toEqual(["ws1: 1 held, opener, emailed 1"]);
  });

  it("sends nothing when the gate cannot be read, rather than a digest the account may not be able to use", async () => {
    accountTrialGate.mockRejectedValueOnce(new Error("quota: could not read this account's plan (timeout)"));
    const out = await sendHeldDigests(db().client, [held("a1")], NOW);
    expect(out).toEqual(["ws1: digest failed (quota: could not read this account's plan (timeout))"]);
    expect(send).not.toHaveBeenCalled();
  });
});
