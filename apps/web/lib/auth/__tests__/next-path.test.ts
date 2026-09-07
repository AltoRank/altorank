import { describe, it, expect } from "vitest";
import { safeNextPath, afterSignIn, DEFAULT_AFTER_SIGN_IN } from "../next-path";

/**
 * Two threat models met here, because two branches wrote this helper
 * independently and each was worried about something the other was not.
 *
 * The connector flow (`/oauth/authorize?...` → sign in → back) cares that a
 * legitimate destination survives byte for byte. The email flow cares that
 * `/articles?status=review` stops becoming `/signin?status=review` - the query
 * surviving while the destination did not - and that nothing hostile in a
 * mailed link can steer the reader off this origin. Both sets of cases are
 * kept; neither was written from the other's list.
 */
describe("safeNextPath keeps a same-origin destination", () => {
  it.each([
    ["/dashboard", "/dashboard"],
    ["/articles?status=review", "/articles?status=review"],
    ["/content/1f3c-9a", "/content/1f3c-9a"],
    ["/improvements/42?from=email", "/improvements/42?from=email"],
    ["/settings/billing#plan", "/settings/billing#plan"],
    ["/onboarding?step=5", "/onboarding?step=5"],
    // Percent-encoded content inside a path is just a path.
    ["/content/a%20b", "/content/a%20b"],
    ["  /keywords  ", "/keywords"],
    // The consent screen's own bounce, which must round-trip untouched or the
    // connector loses its client_id, PKCE challenge and state.
    ["/oauth/authorize?client_id=a&state=b", "/oauth/authorize?client_id=a&state=b"],
  ])("%s → %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  /**
   * The real thing `app/oauth/authorize/page.tsx` builds, rather than a
   * shortened stand-in: an encoded redirect_uri, a `+`/`/`/`=` state and a
   * base64url PKCE challenge all have to come back unchanged, or the connector
   * loses the request it sent the person here with.
   */
  it("round-trips a full OAuth consent bounce byte for byte", () => {
    const here = new URL("/oauth/authorize", "http://x");
    for (const [k, v] of Object.entries({
      client_id: "cid_9f3a-b21c",
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect?x=1",
      state: "abc+def/ghi=jkl&mno",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      response_type: "code",
      scope: "articles:read articles:write workspaces:read",
    })) {
      here.searchParams.set(k, v);
    }
    const built = `${here.pathname}${here.search}`;
    expect(safeNextPath(built)).toBe(built);
  });
});

/**
 * Everything below would be an open redirect if it were honoured: the reader
 * signs in on our page and is handed to somebody else's, still believing they
 * are on ours. "Starts with a slash" does not catch it - `//evil.com` starts
 * with one, and browsers normalise `/\evil.com` into the same thing.
 */
describe("safeNextPath refuses anything that leaves this origin", () => {
  it.each([
    ["absolute https", "https://evil.com/phish"],
    ["absolute http", "http://evil.com"],
    ["absolute, bare host", "https://evil.example"],
    ["protocol-relative", "//evil.com"],
    ["protocol-relative, bare host", "//evil.example"],
    ["protocol-relative with path", "//evil.com/dashboard"],
    ["backslash authority", "/\\evil.com"],
    ["backslash authority, bare host", "/\\evil.example"],
    ["double backslash", "\\\\evil.com"],
    ["encoded slash authority", "/%2f%2fevil.com"],
    ["encoded backslash authority", "/%5cevil.com"],
    ["triple slash", "///evil.com"],
    ["slash then backslash", "/\\/evil.com"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["scheme-relative with credentials", "//user:pass@evil.com/"],
    ["not rooted", "dashboard"],
    ["not rooted, relative", "../../etc/passwd"],
    ["empty", ""],
    ["whitespace only", "   "],
    ["header splitting", "/dashboard\r\nSet-Cookie: a=b"],
    ["null byte", "/dashboard\u0000"],
    ["tab inside a scheme", "java\tscript:alert(1)"],
  ])("refuses %s", (_name, input) => {
    expect(safeNextPath(input)).toBeNull();
  });

  it("refuses a value that is not a string at all", () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath(42)).toBeNull();
    // What `formData.get()` hands back when the field arrived as a file.
    expect(safeNextPath({ name: "/dashboard" })).toBeNull();
  });

  it.each([3000, 4000])("refuses an absurdly long path (%i chars) rather than reflecting it", (n) => {
    expect(safeNextPath(`/${"a".repeat(n)}`)).toBeNull();
  });

  /** A destination that is the page you are on is a loop, not a destination. */
  it.each(["/signin", "/signin?error=x", "/signup", "/signup/anything"])("refuses %s", (input) => {
    expect(safeNextPath(input)).toBeNull();
  });
});

describe("afterSignIn", () => {
  it("falls back to the dashboard when there is nothing usable", () => {
    expect(afterSignIn(null)).toBe(DEFAULT_AFTER_SIGN_IN);
    expect(afterSignIn("//evil.com")).toBe(DEFAULT_AFTER_SIGN_IN);
    expect(afterSignIn("https://evil.com")).toBe("/dashboard");
  });

  it("honours a real destination", () => {
    expect(afterSignIn("/articles?status=review")).toBe("/articles?status=review");
  });
});
