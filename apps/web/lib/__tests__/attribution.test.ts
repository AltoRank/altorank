import { describe, it, expect } from "vitest";
import { ATTRIBUTION_SOURCES, ATTRIBUTION_NOTE_MAX, parseAttribution, isAttributionSource, attributionLabel } from "../attribution";

describe("parseAttribution", () => {
  it("accepts every listed source without a note", () => {
    for (const { id } of ATTRIBUTION_SOURCES) {
      if (id === "other") continue;
      expect(parseAttribution(id, null)).toEqual({ source: id, note: null });
    }
  });

  it("rejects a source that is not in the list", () => {
    expect(() => parseAttribution("bing", null)).toThrow();
    expect(() => parseAttribution("", null)).toThrow();
    expect(() => parseAttribution(undefined, null)).toThrow();
    expect(() => parseAttribution(42, null)).toThrow();
    // Close is not the same: the column's CHECK would refuse these too.
    expect(() => parseAttribution("Google", null)).toThrow();
    expect(() => parseAttribution(" ai", null)).toThrow();
  });

  it("requires words behind Other", () => {
    expect(() => parseAttribution("other", null)).toThrow();
    expect(() => parseAttribution("other", "")).toThrow();
    expect(() => parseAttribution("other", "   ")).toThrow();
    expect(() => parseAttribution("other", 7)).toThrow();
    expect(parseAttribution("other", "  a Slack community  ")).toEqual({ source: "other", note: "a Slack community" });
  });

  it("caps the note rather than refusing it", () => {
    const long = "x".repeat(ATTRIBUTION_NOTE_MAX + 50);
    expect(parseAttribution("other", long).note).toHaveLength(ATTRIBUTION_NOTE_MAX);
  });

  it("drops a note sent with any source that is not Other", () => {
    expect(parseAttribution("google", "left over from a changed mind").note).toBeNull();
    expect(parseAttribution("ai", "asked it for tools").note).toBeNull();
  });
});

describe("the list", () => {
  it("has the AI answer as a first-class option", () => {
    expect(isAttributionSource("ai")).toBe(true);
    expect(attributionLabel("ai")).toMatch(/AI/);
  });

  it("names every source once and ends on Other", () => {
    const ids = ATTRIBUTION_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[ids.length - 1]).toBe("other");
  });

  it("matches the CHECK constraint in migration 058", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const sql = fs.readFileSync(path.resolve(__dirname, "../../supabase/migrations/058_agency_attribution.sql"), "utf8");
    const inList = sql.match(/attribution_source in \(([^)]+)\)/)?.[1] ?? "";
    const dbIds = inList.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(dbIds).toEqual(ATTRIBUTION_SOURCES.map((s) => s.id));
  });
});
