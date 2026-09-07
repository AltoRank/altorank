import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const sendTransactionalEmail = vi.fn();
vi.mock("../resend", () => ({
  sendTransactionalEmail: (...a: unknown[]) => sendTransactionalEmail(...a),
}));

import { renderMonthlyReport, sendMonthlyReportEmails } from "../report-email";
import { fakeEmailDb as db } from "./fake-email-db";

beforeAll(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "a-test-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
});
afterAll(() => {
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

const base = {
  workspaceName: "Alpha",
  agencyName: "Email Audit",
  period: "2026-08-01 to 2026-08-31",
  reportUrl: "https://storage.example/report.pdf?token=abc",
  highlights: { articlesPublished: 4, keywordsTracked: 37 },
};

const scope = { agencyId: "ag-1", workspaceId: "ws-1" };

beforeEach(() => {
  sendTransactionalEmail.mockReset();
  sendTransactionalEmail.mockResolvedValue(undefined);
});

describe("renderMonthlyReport", () => {
  it("names the workspace and the period in the subject", () => {
    expect(renderMonthlyReport(base, "a@x.co").subject).toBe(
      "Alpha — SEO report for 2026-08-01 to 2026-08-31",
    );
  });

  it("escapes the workspace and agency names, both of them customer input", () => {
    const r = renderMonthlyReport(
      { ...base, workspaceName: "<script>alert(1)</script>", agencyName: '"><img src=x>' },
      "a@x.co",
    );
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<img src=x>");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("links to the report and says how long the link lasts", () => {
    const r = renderMonthlyReport(base, "a@x.co");
    expect(r.html).toContain("https://storage.example/report.pdf?token=abc");
    expect(r.html).toContain("30 days");
  });
});

/**
 * `reports` is optional and the preferences page shows a switch for it. Before
 * this the switch did nothing: a captured report reached an address whose
 * `email_preferences.unsubscribed` was `{reports}`, with `headers: null`.
 */
describe("sendMonthlyReportEmails", () => {
  it("sends one per recipient", async () => {
    const { client } = db();
    const r = await sendMonthlyReportEmails(client, ["a@x.co", "b@x.co"], base, scope);
    expect(r).toEqual({ sent: 2, skipped: 0, failed: 0 });
  });

  it("sends nothing to an address that unsubscribed from reports", async () => {
    const { client } = db({ preferences: { "off@x.co": ["reports"] } });
    const r = await sendMonthlyReportEmails(client, ["off@x.co", "on@x.co"], base, scope);
    expect(r).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(sendTransactionalEmail.mock.calls[0]![0]).toBe("on@x.co");
  });

  /** A hand-retriggered cron must not mail everybody a second copy. */
  it("sends once per workspace and period", async () => {
    const { client } = db();
    await sendMonthlyReportEmails(client, ["a@x.co"], base, scope);
    const again = await sendMonthlyReportEmails(client, ["a@x.co"], base, scope);
    expect(again).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
  });

  it("still sends next month, and for a different workspace", async () => {
    const { client } = db();
    await sendMonthlyReportEmails(client, ["a@x.co"], base, scope);
    expect(
      (await sendMonthlyReportEmails(client, ["a@x.co"], { ...base, period: "2026-09-01 to 2026-09-30" }, scope)).sent,
    ).toBe(1);
    expect(
      (await sendMonthlyReportEmails(client, ["a@x.co"], base, { ...scope, workspaceId: "ws-2" })).sent,
    ).toBe(1);
  });

  it("carries an unsubscribe link and the List-Unsubscribe headers", async () => {
    const { client } = db();
    await sendMonthlyReportEmails(client, ["a@x.co"], base, scope);
    const opts = sendTransactionalEmail.mock.calls[0]![5] as {
      headers?: Record<string, string>;
      unsubscribeUrl?: string | null;
    };
    expect(opts.unsubscribeUrl).toContain("c=reports");
    expect(opts.headers?.["List-Unsubscribe"]).toContain("/api/unsubscribe?");
    expect(opts.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("records the claim against the workspace and the period", async () => {
    const { client, inserted } = db();
    await sendMonthlyReportEmails(client, ["a@x.co"], base, scope);
    expect(inserted[0]).toMatchObject({
      email_type: "monthly_report",
      subject_id: "ws-1:2026-08-01 to 2026-08-31",
      recipient: "a@x.co",
      agency_id: "ag-1",
      workspace_id: "ws-1",
    });
  });

  /** The PDF exists either way; a mail outage must not fail the cron. */
  it("reports a refusal rather than throwing", async () => {
    const { client } = db();
    sendTransactionalEmail.mockRejectedValueOnce(new Error("Resend refused the email (rate_limit 429)"));
    const r = await sendMonthlyReportEmails(client, ["a@x.co"], base, scope);
    expect(r.failed).toBe(1);
    expect(r.lastError).toContain("429");
  });
});
