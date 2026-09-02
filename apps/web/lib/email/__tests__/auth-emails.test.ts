import { describe, it, expect, vi, beforeEach } from "vitest";

// Supabase and Resend are replaced: what matters here is which of their
// answers stays silent and which is thrown.
const { generateLink, sendTransactionalEmail } = vi.hoisted(() => ({
  generateLink: vi.fn(),
  sendTransactionalEmail: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ auth: { admin: { generateLink } } }),
}));
vi.mock("@/lib/email/resend", () => ({ sendTransactionalEmail }));

import { authLink, renderConfirmSignup, renderPasswordReset, renderMagicLink, sendPasswordReset } from "../auth-emails";
import { emailLayout } from "../layout";

describe("auth emails", () => {
  it("builds a callback link with hash, type and next", () => {
    const u = new URL(authLink("recovery", "abc123", "/reset-password/confirm"));
    expect(u.pathname).toBe("/callback");
    expect(u.searchParams.get("token_hash")).toBe("abc123");
    expect(u.searchParams.get("type")).toBe("recovery");
    expect(u.searchParams.get("next")).toBe("/reset-password/confirm");
  });

  it("renders branded bodies that carry the link and escape the address", () => {
    const url = "https://app.altorank.co/callback?token_hash=x&type=signup";
    for (const r of [renderConfirmSignup(url, "a<b@x.co"), renderPasswordReset(url, "a<b@x.co"), renderMagicLink(url, "a<b@x.co")]) {
      expect(r.subject).toContain("AltoRank");
      // Attribute values are escaped, so the & in the query becomes &amp;.
      expect(r.html).toContain(url.replace("&", "&amp;"));
      // The address lives in the footer note only, escaped by the layout.
      const full = emailLayout({ title: r.subject, bodyHtml: r.html, footerNote: r.footerNote });
      expect(full).not.toContain("a<b@x.co");
      expect(full).toContain("a&lt;b@x.co");
      expect((full.match(/Sent to/g) ?? []).length).toBe(1);
      expect(full).toContain("SUPALABS SRL");
      expect(full).toContain("#4B52D4");
    }
  });
});

describe("sendPasswordReset", () => {
  beforeEach(() => {
    generateLink.mockReset();
    sendTransactionalEmail.mockReset();
    sendTransactionalEmail.mockResolvedValue(undefined);
  });

  it("is silent for an address with no account", async () => {
    generateLink.mockResolvedValue({
      data: { properties: null, user: null },
      error: { code: "user_not_found", status: 404, message: "User not found" },
    });
    await expect(sendPasswordReset("nobody@x.co")).resolves.toBe(false);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it("throws on any other link failure, so a bad service key is not mistaken for a missing account", async () => {
    generateLink.mockResolvedValue({
      data: { properties: null, user: null },
      error: { code: undefined, status: 401, message: "Invalid API key" },
    });
    await expect(sendPasswordReset("a@x.co")).rejects.toThrow("Could not generate the recovery link: Invalid API key");
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it("sends the callback link when the account exists", async () => {
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: "h4sh" }, user: { id: "u1" } },
      error: null,
    });
    await expect(sendPasswordReset("a@x.co")).resolves.toBe(true);
    expect(generateLink).toHaveBeenCalledWith({ type: "recovery", email: "a@x.co" });
    const [to, subject, html, footerNote] = sendTransactionalEmail.mock.calls[0];
    expect(to).toBe("a@x.co");
    expect(subject).toBe("Reset your AltoRank password");
    expect(html).toContain("token_hash=h4sh");
    expect(html).toContain("type=recovery");
    expect(footerNote).toContain("a@x.co");
  });

  it("surfaces a refused send instead of reporting it as sent", async () => {
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: "h" }, user: { id: "u1" } },
      error: null,
    });
    sendTransactionalEmail.mockRejectedValue(new Error("Resend refused the email (validation_error 403): domain not verified"));
    await expect(sendPasswordReset("a@x.co")).rejects.toThrow("Resend refused the email");
  });
});
