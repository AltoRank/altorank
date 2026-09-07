import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendTransactionalEmail } = vi.hoisted(() => ({ sendTransactionalEmail: vi.fn() }));
vi.mock("../resend", () => ({ sendTransactionalEmail }));

import { sendOnce, normalizeRecipients, describeSendOutcome } from "../send-once";
import { fakeEmailDb as db } from "./fake-email-db";

const render = () => ({ subject: "S", html: "<p>H</p>", footerNote: "F", preheader: "P" });

describe("normalizeRecipients", () => {
  it("lowercases, trims, deduplicates and drops non-addresses", () => {
    expect(normalizeRecipients([" A@X.co ", "a@x.co", null, undefined, "", "nope"])).toEqual(["a@x.co"]);
  });
});

describe("sendOnce", () => {
  beforeEach(() => {
    sendTransactionalEmail.mockReset();
    sendTransactionalEmail.mockResolvedValue(undefined);
  });

  it("sends once per recipient and records the claim", async () => {
    const { client, inserted } = db();
    const out = await sendOnce(client, ["a@x.co", "b@x.co"], meta(), render);
    expect(out).toMatchObject({ sent: 2, skipped: 0, failed: 0 });
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2);
    expect(inserted.map((r) => r.recipient)).toEqual(["a@x.co", "b@x.co"]);
    expect(inserted[0]).toMatchObject({ email_type: "t", subject_id: "s1", agency_id: "ag1", workspace_id: "ws1" });
  });

  /** The whole point: a retried webhook or a re-run cron must not re-send. */
  it("does not send twice for the same (type, subject, recipient)", async () => {
    const { client } = db();
    await sendOnce(client, ["a@x.co"], meta(), render);
    const second = await sendOnce(client, ["a@x.co"], meta(), render);
    expect(second).toMatchObject({ sent: 0, skipped: 1 });
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
  });

  it("sends again for a different subject", async () => {
    const { client } = db();
    await sendOnce(client, ["a@x.co"], meta("s1"), render);
    await sendOnce(client, ["a@x.co"], meta("s2"), render);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2);
  });

  /** A failed send releases the claim, so the next run can try again. */
  it("releases the claim when the send fails, and retries next time", async () => {
    const { client, deleted } = db();
    sendTransactionalEmail.mockRejectedValueOnce(new Error("Resend refused the email"));
    const first = await sendOnce(client, ["a@x.co"], meta(), render);
    expect(first).toMatchObject({ sent: 0, failed: 1, lastError: "Resend refused the email" });
    expect(deleted).toEqual(["t|s1|a@x.co"]);

    const second = await sendOnce(client, ["a@x.co"], meta(), render);
    expect(second).toMatchObject({ sent: 1 });
  });

  /** A ledger we cannot write is a reason not to send, not to send anyway. */
  it("does not send when the claim cannot be written", async () => {
    const { client } = db({ claimError: "permission denied" });
    const out = await sendOnce(client, ["a@x.co"], meta(), render);
    expect(out).toMatchObject({ sent: 0, failed: 1 });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it("skips an address that opted out of an optional category", async () => {
    const { client } = db({ preferences: { "b@x.co": ["publishing"] } });
    const out = await sendOnce(client, ["a@x.co", "b@x.co"], { ...meta(), category: "publishing" }, render);
    expect(out).toMatchObject({ sent: 1, skipped: 1 });
    expect(sendTransactionalEmail.mock.calls[0][0]).toBe("a@x.co");
  });

  it("honours the 'all' pseudo-category", async () => {
    const { client } = db({ preferences: { "a@x.co": ["all"] } });
    const out = await sendOnce(client, ["a@x.co"], { ...meta(), category: "reports" }, render);
    expect(out).toMatchObject({ sent: 0, skipped: 1 });
  });

  /**
   * The line the product will not cross: a customer cannot switch off the
   * notice that their card was declined.
   */
  it("ignores an opt-out for a required category", async () => {
    const { client } = db({ preferences: { "a@x.co": ["all", "billing"] } });
    const out = await sendOnce(client, ["a@x.co"], { ...meta(), category: "billing" }, render);
    expect(out).toMatchObject({ sent: 1, skipped: 0 });
  });

  /** An unreadable preferences table must not silence the mail. */
  it("sends when preferences cannot be read", async () => {
    const { client } = db({ prefsError: "relation does not exist" });
    const out = await sendOnce(client, ["a@x.co"], { ...meta(), category: "drafts" }, render);
    expect(out).toMatchObject({ sent: 1 });
  });

  it("carries an unsubscribe link and List-Unsubscribe for optional categories only", async () => {
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
    const { client } = db();
    await sendOnce(client, ["a@x.co"], { ...meta(), category: "drafts" }, render);
    const optional = sendTransactionalEmail.mock.calls[0][5];
    expect(optional.unsubscribeUrl).toContain("/unsubscribe?");
    expect(optional.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(optional.headers["List-Unsubscribe"]).toContain("/api/unsubscribe?");

    sendTransactionalEmail.mockClear();
    await sendOnce(client, ["a@x.co"], { ...meta("s9"), category: "billing" }, render);
    const required = sendTransactionalEmail.mock.calls[0][5];
    expect(required.unsubscribeUrl).toBeNull();
    expect(required.headers).toBeUndefined();
    delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  });

  it("does nothing, quietly, with nobody to send to", async () => {
    const { client } = db();
    expect(await sendOnce(client, [null, ""], meta(), render)).toEqual({ sent: 0, skipped: 0, failed: 0 });
  });
});

describe("describeSendOutcome", () => {
  it("says what a run did, for the cron's JSON", () => {
    expect(describeSendOutcome({ sent: 2, skipped: 1, failed: 0 })).toBe("emailed 2, 1 already told or opted out");
    expect(describeSendOutcome({ sent: 0, skipped: 0, failed: 0 })).toBe("nobody to email");
    expect(describeSendOutcome({ sent: 0, skipped: 0, failed: 1, lastError: "refused" })).toContain("refused");
  });
});

function meta(subjectId = "s1") {
  return {
    type: "t",
    subjectId,
    category: "publishing" as const,
    agencyId: "ag1",
    workspaceId: "ws1",
  };
}
