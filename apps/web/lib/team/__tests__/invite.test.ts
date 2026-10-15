import { describe, expect, it } from "vitest";
import { inviteJoinPath, inviteSignInPath, inviteTokenFromNext } from "@/lib/team/invite";
import { renderConfirmInvite } from "@/lib/email/auth-emails";

describe("invite paths", () => {
  it("signs in with `next` back to the invite and joins on its own page", () => {
    expect(inviteSignInPath("abc")).toBe("/signin?next=%2Finvite%2Fabc");
    expect(inviteJoinPath("abc")).toBe("/invite/abc/join");
  });

  it("reads the token only from a bare invite path", () => {
    expect(inviteTokenFromNext("/invite/abc123")).toBe("abc123");
    expect(inviteTokenFromNext("/invite/abc123/join")).toBeNull();
    expect(inviteTokenFromNext("/invite/../dashboard")).toBeNull();
    expect(inviteTokenFromNext("/dashboard")).toBeNull();
    expect(inviteTokenFromNext(null)).toBeNull();
  });
});

describe("renderConfirmInvite", () => {
  it("names the account it joins, escaped, and promises no site or trial", () => {
    const { html, subject } = renderConfirmInvite("https://app.example/callback?x=1", "a@b.co", "<b>Acme</b>");
    expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(html).not.toContain("<b>Acme</b>");
    expect(html).not.toMatch(/workspace is already set up|first drafts/i);
    expect(subject).toContain("Acme");
  });
});
