import { describe, expect, it } from "vitest";
import { partitionByShape, queryMovers, windows, type GscRow } from "../analysis";

const today = new Date("2026-11-08T00:00:00Z");
const w = windows(today, 7);
const row = (date: string, query: string, impressions: number, clicks = 0, avg_position = 10): GscRow => ({
  metric_date: date, query, impressions, clicks, avg_position, page_url: null,
});

describe("queryMovers", () => {
  it("compares each query across the two windows, biggest move first", () => {
    const gsc = partitionByShape([
      row(w.current.start, "rising", 50, 2, 8),
      row(w.previous.start, "rising", 10, 0, 12),
      row(w.current.start, "falling", 1, 0, 30),
      row(w.previous.start, "falling", 20, 1, 15),
      row(w.current.start, "brand new", 5),
      row(w.previous.start, "gone", 7),
    ]);
    const moves = queryMovers(gsc, today, 7);
    expect(moves[0].query).toBe("rising");
    expect(moves[0]).toMatchObject({ impressionsChange: 40, clicksChange: 2, positionChange: 4 });
    const falling = moves.find((m) => m.query === "falling")!;
    expect(falling.positionChange).toBe(-15);
    expect(moves.find((m) => m.query === "brand new")!.previous).toBeNull();
    expect(moves.find((m) => m.query === "gone")!.current.impressions).toBe(0);
  });
});
