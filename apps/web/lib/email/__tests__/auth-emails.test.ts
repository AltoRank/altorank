import { describe, it, expect } from "vitest";
import { authLink, renderConfirmSignup, renderPasswordReset, renderMagicLink } from "../auth-emails";
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
      expect(r.html).not.toContain("a<b@x.co");
      expect(r.html).toContain("a&lt;b@x.co");
      const full = emailLayout({ title: r.subject, bodyHtml: r.html });
      expect(full).toContain("SUPALABS SRL");
      expect(full).toContain("#4B52D4");
    }
  });
});
