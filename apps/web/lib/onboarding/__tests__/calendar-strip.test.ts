import { describe, it, expect } from "vitest";
import { calendarStripDays, STRIP_DAYS } from "../calendar-strip";
import { buildPlan } from "../plan";
import type { OnboardingPlanned } from "../events";

// ---------------------------------------------------------------------------
// The strip could only ever fill one of its seven squares
// ---------------------------------------------------------------------------
//
// `CalendarStrip` took `{ drafting, article }` and gated every content branch
// on `i === 1`. A run that planned seven articles across 09-07…09-13 drew
// those exact dates as seven empty boxes, above a SCHEDULED list naming all
// seven. These tests are about the arithmetic that replaced it: the window
// comes from the plan, every planned day carries its terms, and nothing the
// plan holds is silently dropped off the end.

const p = (date: string, term: string): OnboardingPlanned => ({ date, term });
const NOW = new Date("2026-09-07T10:00:00Z");

describe("calendarStripDays", () => {
  it("fills every day the plan touches, not only the first", () => {
    const planned = ["07", "08", "09", "10", "11", "12", "13"].map((d, i) => p(`2026-09-${d}`, `term ${i}`));
    const { days } = calendarStripDays(planned, NOW);
    expect(days).toHaveLength(STRIP_DAYS);
    expect(days.map((d) => d.terms)).toEqual([
      ["term 0"], ["term 1"], ["term 2"], ["term 3"], ["term 4"], ["term 5"], ["term 6"],
    ]);
  });

  it("starts the window on the plan's own first day, not yesterday", () => {
    const { days } = calendarStripDays([p("2026-09-09", "a")], NOW);
    expect(days[0].date).toBe("2026-09-09");
    expect(days[days.length - 1].date).toBe("2026-09-15");
  });

  it("starts today when nothing is planned yet, and draws empty squares", () => {
    const { days, beyond, lastDate, draftDate } = calendarStripDays([], NOW);
    expect(days[0].date).toBe("2026-09-07");
    expect(days.every((d) => d.terms.length === 0)).toBe(true);
    expect(beyond).toBe(0);
    expect(lastDate).toBeNull();
    // The draft still lands somewhere: today, which is where the pipeline puts
    // it when planning produced nothing to hang it on.
    expect(draftDate).toBe("2026-09-07");
  });

  it("marks today, and only today, against the plan's own UTC frame", () => {
    const planned = ["05", "06", "07", "08"].map((d) => p(`2026-09-${d}`, d));
    const { days } = calendarStripDays(planned, NOW);
    expect(days.filter((d) => d.isToday).map((d) => d.date)).toEqual(["2026-09-07"]);
  });

  it("has no today square when the plan's week does not contain today", () => {
    const { days } = calendarStripDays([p("2026-10-01", "later")], NOW);
    expect(days.some((d) => d.isToday)).toBe(false);
  });

  it("groups several entries onto one day, in plan order", () => {
    const { days } = calendarStripDays([p("2026-09-07", "one"), p("2026-09-07", "two")], NOW);
    expect(days[0].terms).toEqual(["one", "two"]);
  });

  it("counts what falls past the last square instead of dropping it", () => {
    const planned = Array.from({ length: 10 }, (_, i) =>
      p(new Date(Date.UTC(2026, 8, 7) + i * 3 * 86_400_000).toISOString().slice(0, 10), `t${i}`),
    );
    const { beyond, lastDate } = calendarStripDays(planned, NOW);
    // Days 07..13 hold three (07, 10, 13); the other seven are later.
    expect(beyond).toBe(7);
    expect(lastDate).toBe("2026-10-04");
  });

  it("puts the draft on the first planned day, which is the one the writer gets", () => {
    const { draftDate } = calendarStripDays([p("2026-09-08", "first"), p("2026-09-11", "second")], NOW);
    expect(draftDate).toBe("2026-09-08");
  });

  it("ignores an entry with no date rather than rendering an Invalid Date square", () => {
    const planned = [{ term: "orphan", date: "" }, p("2026-09-07", "real")];
    const { days } = calendarStripDays(planned, NOW);
    expect(days[0]).toMatchObject({ date: "2026-09-07", terms: ["real"] });
  });

  it("agrees with a plan the planner actually built", () => {
    const recs = Array.from({ length: 12 }, (_, i) => ({
      keywordId: `k${i}`,
      term: `keyword ${i}`,
      action: "write" as const,
      quality: "ok" as const,
    }));
    const plan = buildPlan(recs, { weeklyLimit: 7, from: NOW });
    const { days, beyond } = calendarStripDays(
      plan.map(({ term, date }) => ({ term, date })),
      NOW,
    );
    // One a day from today: the whole first week is full, and the rest is
    // counted rather than hidden.
    expect(days.every((d) => d.terms.length === 1)).toBe(true);
    expect(beyond).toBe(plan.length - STRIP_DAYS);
  });
});
