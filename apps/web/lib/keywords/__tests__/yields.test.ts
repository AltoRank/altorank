import { describe, it, expect } from "vitest";
import { rollupSourceYields, yieldsForInputs } from "../yields";

const kws = [
  { id: "a", source_type: "competitor", source_ref: "semrush.com" },
  { id: "b", source_type: "competitor", source_ref: "semrush.com" },
  { id: "c", source_type: "competitor", source_ref: "ahrefs.com" },
  { id: "d", source_type: "profile", source_ref: null },
  { id: "e", source_type: null, source_ref: null },
];

describe("rollupSourceYields", () => {
  it("counts written before scheduled, and stored as the rest", () => {
    const y = rollupSourceYields(kws, ["a", "a", null], ["a", "b"]);
    expect(y.total).toBe(5);
    // `a` is both planned and written: written wins, it is not counted twice.
    expect(y.written).toBe(1);
    expect(y.scheduled).toBe(1);
    expect(y.stored).toBe(3);
  });
  it("groups by type and ref, most productive first", () => {
    const y = rollupSourceYields(kws, ["c"], []);
    expect(y.bySource[0]).toEqual({ source_type: "competitor", source_ref: "semrush.com", keywords: 2, articles: 0 });
    expect(y.bySource.find((s) => s.source_ref === "ahrefs.com")?.articles).toBe(1);
    // Provenance-less rows are grouped as unknown, not dropped and not zeroed.
    expect(y.bySource.find((s) => s.source_type === "unknown")?.keywords).toBe(1);
  });
});

describe("yieldsForInputs", () => {
  it("reports zero for a named input that produced nothing", () => {
    const y = rollupSourceYields(kws, [], []);
    const rows = yieldsForInputs(["semrush.com", "moz.com"], "competitor", y);
    expect(rows).toEqual([
      { input: "semrush.com", keywords: 2, articles: 0 },
      { input: "ahrefs.com", keywords: 1, articles: 0 },
      { input: "moz.com", keywords: 0, articles: 0 },
    ]);
  });
  it("matches inputs regardless of scheme, www and case", () => {
    const y = rollupSourceYields(kws, [], []);
    const rows = yieldsForInputs(["https://www.Semrush.com"], "competitor", y);
    expect(rows[0]).toMatchObject({ input: "https://www.Semrush.com", keywords: 2 });
  });
});
