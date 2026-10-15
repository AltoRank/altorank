import { describe, it, expect, vi, beforeEach } from "vitest";

// The SDK is replaced wholesale. These tests are about how this module reacts
// to what Resend answers, and the answer is the one thing controlled here.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

/** The module caches its client, so each test gets a fresh copy. */
async function freshModule() {
  vi.resetModules();
  return await import("../resend");
}

describe("Resend delivery", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.RESEND_REPLY_TO;
  });

  it("throws when Resend refuses the email, carrying its code and status", async () => {
    // Resend's SDK resolves on a 4xx rather than rejecting. This is its shape
    // for a from-address on a domain the key's team has not verified.
    send.mockResolvedValue({
      data: null,
      error: { name: "validation_error", statusCode: 403, message: "The updates.altorank.co domain is not verified." },
      headers: null,
    });
    const { sendToolResultEmail } = await freshModule();
    await expect(sendToolResultEmail("a@b.co", "Hello", "<p>hi</p>")).rejects.toThrow(
      "Resend refused the email (validation_error 403): The updates.altorank.co domain is not verified.",
    );
  });

  it("resolves when Resend accepts the email", async () => {
    send.mockResolvedValue({ data: { id: "em_1" }, error: null, headers: null });
    const { sendToolResultEmail } = await freshModule();
    await expect(sendToolResultEmail("a@b.co", "Hello", "<p>hi</p>")).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      to: "a@b.co",
      subject: "Hello",
      from: "AltoRank <noreply@updates.altorank.co>",
    });
  });

  it("applies to the auth emails' sender too", async () => {
    send.mockResolvedValue({
      data: null,
      error: { name: "rate_limit_exceeded", statusCode: 429, message: "Too many requests." },
      headers: null,
    });
    const { sendTransactionalEmail } = await freshModule();
    await expect(
      sendTransactionalEmail("a@b.co", "Reset", "<p>x</p>", "Sent to a@b.co because a reset was requested.", "Preheader"),
    ).rejects.toThrow("Resend refused the email (rate_limit_exceeded 429): Too many requests.");
  });

  it("names the missing key instead of sending", async () => {
    delete process.env.RESEND_API_KEY;
    const { sendToolResultEmail } = await freshModule();
    await expect(sendToolResultEmail("a@b.co", "Hello", "<p>hi</p>")).rejects.toThrow("RESEND_API_KEY not configured");
    expect(send).not.toHaveBeenCalled();
  });
  it("escapes the account and inviter names in the invite email", async () => {
    // Both are user-set. An owner could otherwise mail any address arbitrary
    // HTML (a styled link, a fake form) from the verified sending domain.
    send.mockResolvedValue({ data: { id: "em_2" }, error: null, headers: null });
    const { sendInviteEmail } = await freshModule();
    await sendInviteEmail(
      "invitee@example.com",
      '<a href="https://evil.example">Mallory</a>',
      "Acme <img src=x onerror=alert(1)>",
      "editor",
      "https://app.example/invite/abc",
    );
    const { html } = send.mock.calls[0][0] as { html: string };
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('<a href="https://evil.example">');
    expect(html).toContain("Acme &lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;Mallory&lt;/a&gt;");
    // The real link is still a link.
    expect(html).toContain('href="https://app.example/invite/abc"');
  });

  /** noreply@updates.altorank.co has no MX, and the unsubscribe page says "reply to any email". */
  it("sets a Reply-To that reaches a person on our own sender", async () => {
    send.mockResolvedValue({ data: { id: "em_3" }, error: null, headers: null });
    const { sendToolResultEmail } = await freshModule();
    await sendToolResultEmail("a@b.co", "Hello", "<p>hi</p>");
    expect(send.mock.calls[0][0]).toMatchObject({ replyTo: "AltoRank <hello@altorank.co>" });
  });

  it("keeps a caller's own Reply-To", async () => {
    send.mockResolvedValue({ data: { id: "em_4" }, error: null, headers: null });
    const { sendPlainEmail } = await freshModule();
    await sendPlainEmail({ to: "ops@x.co", subject: "Feedback", text: "hi", replyTo: "user@x.co" });
    expect(send.mock.calls[0][0]).toMatchObject({ replyTo: "user@x.co" });
  });

  it("sends no Reply-To of ours from an install's own address unless it sets one", async () => {
    send.mockResolvedValue({ data: { id: "em_5" }, error: null, headers: null });
    process.env.RESEND_FROM_EMAIL = "Ops <mail@selfhost.example>";
    let mod = await freshModule();
    await mod.sendToolResultEmail("a@b.co", "Hello", "<p>hi</p>");
    expect((send.mock.calls[0][0] as { replyTo?: string }).replyTo).toBeUndefined();
    process.env.RESEND_REPLY_TO = "help@selfhost.example";
    mod = await freshModule();
    await mod.sendToolResultEmail("a@b.co", "Hello", "<p>hi</p>");
    expect(send.mock.calls[1][0]).toMatchObject({ replyTo: "help@selfhost.example" });
  });
});
