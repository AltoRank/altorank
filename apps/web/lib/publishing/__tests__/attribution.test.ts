import { describe, it, expect } from "vitest";
import type { Quota } from "@/lib/billing/quota";
import {
  appendAttribution,
  attributionHtml,
  shouldAttribute,
  ATTRIBUTION_ANCHOR,
  ATTRIBUTION_URL,
} from "@/lib/publishing/attribution";

function quota(reason: Quota["reason"]): Quota {
  return { limit: null, used: 0, remaining: null, reason, plan: null };
}

describe("shouldAttribute", () => {
  it("brands the hosted free tier", () => {
    expect(shouldAttribute(quota("no-plan"), false)).toBe(true);
  });

  it("leaves paid, operator and self-host articles clean", () => {
    for (const reason of ["plan", "operator", "self-host"] as const) {
      expect(shouldAttribute(quota(reason), false)).toBe(false);
    }
  });

  it("does not let the white-label toggle remove the free-tier line", () => {
    // Otherwise the setting is the gate, and free is white-label with an
    // extra click.
    expect(shouldAttribute(quota("no-plan"), true)).toBe(true);
  });
});

describe("attributionHtml", () => {
  it("links to the bare canonical URL with a branded anchor", () => {
    const html = attributionHtml();
    expect(html).toContain(`href="${ATTRIBUTION_URL}"`);
    expect(html).toContain(ATTRIBUTION_ANCHOR);
    // A query string would split the link target across URLs.
    expect(html).not.toContain("?");
  });
});

describe("appendAttribution", () => {
  it("appends the line to a body", () => {
    expect(appendAttribution("<p>Body</p>")).toContain("Powered by");
  });

  it("is idempotent, so republishing does not stack badges", () => {
    const once = appendAttribution("<p>Body</p>");
    expect(appendAttribution(once)).toBe(once);
  });

  it("keeps the original body intact", () => {
    expect(appendAttribution("<h2>Title</h2><p>Body</p>")).toContain("<h2>Title</h2><p>Body</p>");
  });
});
