import { describe, expect, it } from "vitest";
import { GEO_PROMPT_MAX, normaliseGeoPrompt } from "../prompts";

describe("normaliseGeoPrompt", () => {
  it("trims and collapses whitespace", () => {
    expect(normaliseGeoPrompt("  free   backlink\nchecker ")).toEqual({ ok: true, value: "free backlink checker" });
  });

  it("refuses an empty or near-empty question", () => {
    expect(normaliseGeoPrompt("  ").ok).toBe(false);
    expect(normaliseGeoPrompt(null).ok).toBe(false);
  });

  it("refuses a paragraph", () => {
    expect(normaliseGeoPrompt("a".repeat(GEO_PROMPT_MAX + 1)).ok).toBe(false);
  });
});
