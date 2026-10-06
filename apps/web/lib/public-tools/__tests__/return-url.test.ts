// The return URL is read out of a query string, so it is an open redirect
// unless everything but one exact shape is refused.

import { describe, it, expect } from "vitest";
import { slugFromToolReturnPath, toolPageUrl, toolReturnPath, toolSlugFromReturnUrl } from "../return-url";
import { safeNextPath } from "@/lib/auth/next-path";

describe("toolSlugFromReturnUrl", () => {
  it.each([
    ["https://altorank.co/tools/seo-title-generator/", "seo-title-generator"],
    ["https://altorank.co/tools/seo-title-generator", "seo-title-generator"],
    ["  https://altorank.co/tools/keyword-research/  ", "keyword-research"],
  ])("accepts %s", (raw, slug) => {
    expect(toolSlugFromReturnUrl(raw)).toBe(slug);
  });

  it.each([
    // other hosts, schemes, ports, credentials
    "https://evil.com/tools/seo-title-generator/",
    "https://altorank.co.evil.com/tools/x/",
    "https://www.altorank.co/tools/x/",
    "https://app.altorank.co/tools/x/",
    "http://altorank.co/tools/x/",
    "https://altorank.co:8443/tools/x/",
    "https://user@altorank.co/tools/x/",
    "https://altorank.co@evil.com/tools/x/",
    "//altorank.co/tools/x/",
    "javascript:alert(1)",
    // other paths
    "https://altorank.co/",
    "https://altorank.co/tools/",
    "https://altorank.co/pricing/",
    "https://altorank.co/tools/x/y/",
    "https://altorank.co/tools/../pricing/",
    "https://altorank.co/tools/%2e%2e/",
    "https://altorank.co/tools/x%2F..%2F/",
    "https://altorank.co/tools/X-Upper/",
    "https://altorank.co/tools/-x/",
    "https://altorank.co/tools/x--y/",
    // anything riding along
    "https://altorank.co/tools/x/?next=https://evil.com",
    "https://altorank.co/tools/x/#https://evil.com",
    "https://altorank.co/tools/x/\nLocation: https://evil.com",
    `https://altorank.co/tools/${"a".repeat(81)}/`,
    "",
  ])("refuses %s", (raw) => {
    expect(toolSlugFromReturnUrl(raw)).toBeNull();
  });

  it("refuses non-strings", () => {
    expect(toolSlugFromReturnUrl(null)).toBeNull();
    expect(toolSlugFromReturnUrl(undefined)).toBeNull();
    expect(toolSlugFromReturnUrl(["https://altorank.co/tools/x/"])).toBeNull();
  });
});

describe("the internal leg", () => {
  it("round-trips a slug through /tool-return/<slug>", () => {
    expect(toolReturnPath("grammar-checker")).toBe("/tool-return/grammar-checker");
    expect(slugFromToolReturnPath("/tool-return/grammar-checker")).toBe("grammar-checker");
    expect(slugFromToolReturnPath("/tool-return/../dashboard")).toBeNull();
    expect(slugFromToolReturnPath("/dashboard")).toBeNull();
  });

  it("is a `next` the sign-in form and the callback both accept", () => {
    expect(safeNextPath(toolReturnPath("grammar-checker"))).toBe("/tool-return/grammar-checker");
    // app/(auth)/callback/route.ts SAFE_NEXT
    expect(/^\/[a-zA-Z0-9/_-]*$/.test(toolReturnPath("grammar-checker"))).toBe(true);
  });

  it("lands on the tool page with run=1, or the hub", () => {
    expect(toolPageUrl("grammar-checker")).toBe("https://altorank.co/tools/grammar-checker/?run=1");
    expect(toolPageUrl(null)).toBe("https://altorank.co/tools/");
  });
});
