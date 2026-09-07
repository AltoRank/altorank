import { describe, it, expect } from "vitest";
import { safeNextPath, afterSignIn, DEFAULT_AFTER_SIGN_IN } from "../next-path";

/**
 * The reason this exists: `/articles?status=review` used to become
 * `/signin?status=review` - the query survived and the destination did not - so
 * the reader who followed "Read the draft" from an email signed in and landed
 * on the dashboard.
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
  ])("%s → %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
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
    ["protocol-relative", "//evil.com"],
    ["protocol-relative with path", "//evil.com/dashboard"],
    ["backslash authority", "/\\evil.com"],
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
    expect(safeNextPath(42 as unknown as string)).toBeNull();
  });

  it("refuses an absurdly long path rather than reflecting it", () => {
    expect(safeNextPath(`/${"a".repeat(4000)}`)).toBeNull();
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
