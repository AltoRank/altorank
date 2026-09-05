import { describe, it, expect } from "vitest";
import { buildMonthCells, splitVisible, isoDay, PER_DAY } from "../day-groups";

const at = (scheduled_date: string, id = scheduled_date) => ({ id, scheduled_date });
const byDate = (e: { scheduled_date: string }) => e.scheduled_date;

describe("buildMonthCells", () => {
  it("starts on Monday and pads to whole weeks", () => {
    // September 2026 starts on a Tuesday and has 30 days: 1 pad + 30 + 4 pad = 35.
    const cells = buildMonthCells([], 2026, 9, byDate);
    expect(cells).toHaveLength(35);
    expect(cells[0]).toBeNull();
    expect(cells[1]).toMatchObject({ date: "2026-09-01", dayNum: 1, items: [] });
    expect(cells[30]).toMatchObject({ date: "2026-09-30", dayNum: 30 });
    expect(cells[31]).toBeNull();
  });

  it("puts every entry on its day, more than one per day included", () => {
    const cells = buildMonthCells(
      [at("2026-09-10", "a"), at("2026-09-10", "b"), at("2026-09-10", "c"), at("2026-09-10", "d"), at("2026-09-11", "e")],
      2026,
      9,
      byDate,
    );
    const tenth = cells.find((c) => c?.date === "2026-09-10")!;
    expect(tenth.items.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(cells.find((c) => c?.date === "2026-09-11")!.items).toHaveLength(1);
  });

  it("reads a timestamp by its UTC day, like the month filter does", () => {
    const cells = buildMonthCells([at("2026-09-05T23:30:00Z", "late")], 2026, 9, byDate);
    expect(cells.find((c) => c?.date === "2026-09-05")!.items).toHaveLength(1);
  });

  it("drops an entry outside the month rather than placing it somewhere", () => {
    const cells = buildMonthCells([at("2026-10-01", "next"), at("2026-08-31", "prev")], 2026, 9, byDate);
    expect(cells.flatMap((c) => c?.items ?? [])).toHaveLength(0);
  });

  it("keeps the order the entries came in", () => {
    const cells = buildMonthCells([at("2026-09-02", "second"), at("2026-09-02", "first")], 2026, 9, byDate);
    expect(cells.find((c) => c?.date === "2026-09-02")!.items.map((i) => i.id)).toEqual(["second", "first"]);
  });
});

describe("splitVisible", () => {
  it("shows up to PER_DAY and counts the rest", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect(splitVisible(items)).toEqual({ shown: ["a", "b", "c"], hidden: 2 });
    expect(PER_DAY).toBe(3);
  });

  it("hides nothing when the day fits", () => {
    expect(splitVisible(["a"])).toEqual({ shown: ["a"], hidden: 0 });
    expect(splitVisible([])).toEqual({ shown: [], hidden: 0 });
  });
});

describe("isoDay", () => {
  it("takes the date part of a date or a timestamp", () => {
    expect(isoDay("2026-09-05")).toBe("2026-09-05");
    expect(isoDay("2026-09-05T08:00:00.000Z")).toBe("2026-09-05");
  });
});
