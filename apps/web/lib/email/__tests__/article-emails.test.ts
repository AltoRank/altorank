import { describe, it, expect, vi, beforeEach } from "vitest";

const sendTransactionalEmail = vi.fn();
vi.mock("../resend", () => ({
  sendTransactionalEmail: (...a: unknown[]) => sendTransactionalEmail(...a),
}));

import { renderArticleDrafted, sendArticleDraftedEmails, articleUrl } from "../article-emails";

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
    expect(renderArticleDrafted(base).footerNote).toContain("Turn it off");
  });
});

describe("sendArticleDraftedEmails", () => {
  it("sends one per recipient", async () => {
    const r = await sendArticleDraftedEmails(["a@x.co", "b@x.co"], base);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ sent: 2, failed: 0 });
  });

  it("does not call the provider when there is nobody to tell", async () => {
    const r = await sendArticleDraftedEmails([], base);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
    expect(r).toEqual({ sent: 0, failed: 0 });
  });

  /** One bad address must not cost the other members their notification. */
  it("keeps going after a refusal and reports it", async () => {
    sendTransactionalEmail
      .mockRejectedValueOnce(new Error("Resend refused the email (validation_error 422)"))
      .mockResolvedValueOnce(undefined);
    const r = await sendArticleDraftedEmails(["bad@x.co", "good@x.co"], base);
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.lastError).toContain("422");
  });
});
