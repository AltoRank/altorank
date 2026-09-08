import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const sendTransactionalEmail = vi.fn();
vi.mock("../resend", () => ({
  sendTransactionalEmail: (...a: unknown[]) => sendTransactionalEmail(...a),
}));

import { renderArticleDrafted, sendArticleDraftedEmails, articleUrl } from "../article-emails";
import { fakeEmailDb as db } from "./fake-email-db";

// Without a secret the unsubscribe link is deliberately not rendered, so the
// header assertions below would pass vacuously.
beforeAll(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "a-test-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
});
afterAll(() => {
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

const base = {
  domain: "altorank.co",
  keyword: "seo agent",
  title: "What an SEO agent actually does",
  wordCount: 1132,
  verdict: "clean" as const,
  reasons: ["27,100 searches/mo", "difficulty 19"],
  articleId: "a1b2",
};

beforeEach(() => {
  sendTransactionalEmail.mockReset();
  sendTransactionalEmail.mockResolvedValue(undefined);
});

describe("renderArticleDrafted", () => {
  it("links to /content/[id], the route that exists", () => {
    // /articles/[id] has no page; a link built that way was a 404 in the UI.
    expect(articleUrl("a1b2")).toMatch(/\/content\/a1b2$/);
    expect(renderArticleDrafted(base).html).toContain("/content/a1b2");
  });

  /**
   * The subject changes shape for high_risk because the reader's job changes:
   * not "read this soon" but "do not publish until you check a number".
   */
  it("warns in the subject when a figure has no source", () => {
    expect(renderArticleDrafted(base).subject).toBe('New draft for altorank.co: "seo agent"');
    const risky = renderArticleDrafted({ ...base, verdict: "high_risk" });
    expect(risky.subject).toBe('Check before publishing: "seo agent" draft for altorank.co');
    expect(risky.html).toContain("no source given anywhere");
  });

  it("escapes the keyword, title and domain, all of which are model output", () => {
    const r = renderArticleDrafted({
      ...base,
      keyword: 'x" onmouseover="alert(1)',
      title: "<script>alert(1)</script>",
      domain: "<b>evil</b>.co",
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain('onmouseover="alert(1)"');
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("names a site even when the workspace has no domain", () => {
    expect(renderArticleDrafted({ ...base, domain: null }).subject).toContain("your site");
  });

  it("says how to stop the emails", () => {
    expect(renderArticleDrafted(base).footerNote).toContain("automatic drafting is on");
  });

  /**
   * The redesign, and the part of it that is a claim rather than a colour: a
   * figure in the stat row is a measurement, so it is only there when
   * something measured it.
   */
  it("puts the word count and the verdict in the stat row", () => {
    const html = renderArticleDrafted(base).html;
    expect(html).toContain("Words");
    expect(html).toContain("1,132");
    expect(html).toContain("Fact check");
    expect(html).toContain("Clean");
  });

  it("shows the keyword's figures when they were looked up", () => {
    const html = renderArticleDrafted({ ...base, volume: 27100, difficulty: 19 }).html;
    expect(html).toContain("27,100");
    expect(html).toContain("/mo");
    expect(html).toContain("Difficulty");
    expect(html).toContain(">19<");
  });

  /**
   * Rule 5 of the house: a keyword typed in by hand carries a null volume all
   * the way through, and a 0 there would read as "nobody searches for this".
   */
  it("renders an unmeasured figure as a dash, and leaves the cell out entirely when nobody looked", () => {
    const looked = renderArticleDrafted({ ...base, volume: null, difficulty: null }).html;
    expect(looked).toContain("Searches");
    expect(looked).toContain("—");
    expect(looked).not.toContain(">0<");

    const didNot = renderArticleDrafted(base).html;
    expect(didNot).not.toContain("Searches");
    expect(didNot).not.toContain("Difficulty");
  });

  it("says nothing publishes without approval, or when it publishes anyway", () => {
    expect(renderArticleDrafted(base).html).toContain("Nothing publishes until you approve it");
    const auto = renderArticleDrafted({ ...base, autoApproveAfter: "2026-09-10T12:00:00.000Z" });
    expect(auto.html).toContain("2026, 12:00 UTC");
    expect(auto.html).not.toContain("Nothing publishes until");
  });

  it("points at connecting a CMS only when there is nothing to publish to", () => {
    expect(renderArticleDrafted({ ...base, cmsConnected: false }).html).toContain("Nothing is connected to publish to yet");
    expect(renderArticleDrafted({ ...base, cmsConnected: true }).html).not.toContain("Nothing is connected");
    expect(renderArticleDrafted(base).html).not.toContain("Nothing is connected");
  });

  /** No image means nothing blocked, nothing tracked, and the same mail in a dark inbox. */
  it("carries no image and no remote font", () => {
    const html = renderArticleDrafted(base).html;
    expect(html).not.toContain("<img");
    expect(html).not.toContain("fonts.googleapis");
  });
});

/**
 * This email was the only lifecycle email that went out *around* sendOnce
 * rather than through it. On the merged tree, two calls with the same article
 * id sent six messages to three recipients, and an address unsubscribed from
 * `drafts` received the next draft with `headers: null`. Each of those is a
 * test below.
 */
describe("sendArticleDraftedEmails", () => {
  it("sends one per recipient", async () => {
    const { client } = db();
    const r = await sendArticleDraftedEmails(client, ["a@x.co", "b@x.co"], base);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ sent: 2, skipped: 0, failed: 0 });
  });

  it("does not call the provider when there is nobody to tell", async () => {
    const { client } = db();
    const r = await sendArticleDraftedEmails(client, [], base);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
    expect(r).toEqual({ sent: 0, skipped: 0, failed: 0 });
  });

  /** Four generate runs a day must not announce one draft four times. */
  it("sends once per article, however often it is called", async () => {
    const { client } = db();
    const to = ["a@x.co", "b@x.co", "c@x.co"];
    const first = await sendArticleDraftedEmails(client, to, base);
    const second = await sendArticleDraftedEmails(client, to, base);
    expect(first.sent).toBe(3);
    expect(second).toEqual({ sent: 0, skipped: 3, failed: 0 });
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(3);
  });

  it("claims the send under the article id, so a different draft still sends", async () => {
    const { client, inserted } = db();
    await sendArticleDraftedEmails(client, ["a@x.co"], base, {
      agencyId: "ag-1",
      workspaceId: "ws-1",
    });
    expect(inserted[0]).toMatchObject({
      email_type: "article_drafted",
      subject_id: "a1b2",
      recipient: "a@x.co",
      agency_id: "ag-1",
      workspace_id: "ws-1",
    });
    const r = await sendArticleDraftedEmails(client, ["a@x.co"], { ...base, articleId: "other" });
    expect(r.sent).toBe(1);
  });

  /** The complaint the preferences page promises to answer. */
  it("sends nothing to an address that unsubscribed from drafts", async () => {
    const { client } = db({ preferences: { "off@x.co": ["drafts"] } });
    const r = await sendArticleDraftedEmails(client, ["off@x.co", "on@x.co"], base);
    expect(r).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(sendTransactionalEmail.mock.calls[0]![0]).toBe("on@x.co");
  });

  it("honours an all-optional opt-out too", async () => {
    const { client } = db({ preferences: { "off@x.co": ["all"] } });
    const r = await sendArticleDraftedEmails(client, ["off@x.co"], base);
    expect(r.skipped).toBe(1);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  /**
   * Both halves of a working opt-out: the footer link a person clicks, and the
   * RFC 8058 header pair a mail client's own unsubscribe button uses.
   */
  it("carries an unsubscribe link and the List-Unsubscribe headers", async () => {
    const { client } = db();
    await sendArticleDraftedEmails(client, ["a@x.co"], base);
    const opts = sendTransactionalEmail.mock.calls[0]![5] as {
      headers?: Record<string, string>;
      unsubscribeUrl?: string | null;
    };
    expect(opts.unsubscribeUrl).toContain("/unsubscribe?");
    expect(opts.unsubscribeUrl).toContain("c=drafts");
    expect(opts.headers?.["List-Unsubscribe"]).toContain("/api/unsubscribe?");
    expect(opts.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  /** One bad address must not cost the other members their notification. */
  it("keeps going after a refusal and reports it", async () => {
    const { client } = db();
    sendTransactionalEmail
      .mockRejectedValueOnce(new Error("Resend refused the email (validation_error 422)"))
      .mockResolvedValueOnce(undefined);
    const r = await sendArticleDraftedEmails(client, ["bad@x.co", "good@x.co"], base);
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.lastError).toContain("422");
  });

  /** A refused send releases its claim, so the next run can try again. */
  it("does not permanently suppress a draft whose first send failed", async () => {
    const { client } = db();
    sendTransactionalEmail.mockRejectedValueOnce(new Error("Resend refused the email"));
    expect((await sendArticleDraftedEmails(client, ["a@x.co"], base)).failed).toBe(1);
    expect((await sendArticleDraftedEmails(client, ["a@x.co"], base)).sent).toBe(1);
  });

  /** The hold link is signed to one address, so it must be rendered per recipient. */
  it("renders per recipient so each hold link is that person's", async () => {
    const { client } = db();
    const seen: string[] = [];
    await sendArticleDraftedEmails(client, ["a@x.co", "b@x.co"], {
      ...base,
      autoApproveAfter: "2026-09-10T12:00:00.000Z",
      holdUrlFor: (to) => {
        seen.push(to);
        return `https://app.altorank.co/hold?a=a1b2&e=${encodeURIComponent(to)}&s=sig-${to}`;
      },
    });
    expect(seen).toEqual(["a@x.co", "b@x.co"]);
    expect(sendTransactionalEmail.mock.calls[0]![2]).toContain("s=sig-a@x.co");
    expect(sendTransactionalEmail.mock.calls[1]![2]).toContain("s=sig-b@x.co");
  });
});
