import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shareUrl } from "../url";

describe("shareUrl", () => {
  it("builds the link under /share, with or without a trailing slash on the origin", () => {
    expect(shareUrl("https://app.altorank.co/", "abc")).toBe("https://app.altorank.co/share/abc");
    expect(shareUrl("https://app.altorank.co", "abc")).toBe("https://app.altorank.co/share/abc");
    expect(shareUrl("", "abc")).toBe("/share/abc");
  });

  // The client "Copy link" button imports this module. The token module it
  // was split from imports node:crypto, which has no business in a browser
  // bundle; this pins the split so the import cannot quietly grow back.
  it("imports nothing, so a client component can use it", () => {
    const src = readFileSync(join(__dirname, "..", "url.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    const button = readFileSync(join(__dirname, "..", "..", "..", "components", "dashboard", "share-results.tsx"), "utf8");
    expect(button).toContain('from "@/lib/share/url"');
    expect(button).not.toContain('from "@/lib/share/token"');
  });
});
