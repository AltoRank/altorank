import { describe, it, expect } from "vitest";
import { isCadenceDue, cadenceDueState, cadenceLocalDate, withoutPaused } from "../cadence";

// These tests replace the isCadenceSlotNow suite. That function matched a
// 15-minute window starting at publish_time, which required a cron every 15
// minutes. Vercel's Hobby plan runs crons once per day at ±59 min precision, so
// the window was missed on nearly every run and cadence publishing never fired.
//
// The contract is now "due and not yet done today", so the cases that matter
// are: does it fire at all on a daily cron, and does it fire only once.

describe("isCadenceDue", () => {
  // Wednesday 2026-04-29, 10:05 CET (08:05 UTC)
  const wednesday1005CET = new Date("2026-04-29T08:05:00Z");

  const baseCadence = {
    timezone: "Europe/Rome",
    days_of_week: [1, 3, 5], // Mon, Wed, Fri
    publish_time: "10:00",
  };

  it("is due on an enabled day once past publish_time", () => {
    expect(isCadenceDue(baseCadence, wednesday1005CET, null)).toBe(true);
  });

  it("is due at exactly publish_time", () => {
    const exact = new Date("2026-04-29T08:00:00Z"); // 10:00 CET
    expect(isCadenceDue(baseCadence, exact, null)).toBe(true);
  });

  it("is NOT due before publish_time", () => {
    const before = new Date("2026-04-29T07:59:00Z"); // 09:59 CET
    expect(isCadenceDue(baseCadence, before, null)).toBe(false);
  });

  it("is still due hours later, which is the whole point", () => {
    // The old 15-minute window returned false here, so a daily cron firing at
    // 16:00 would silently publish nothing. This is the regression being fixed.
    const muchLater = new Date("2026-04-29T14:00:00Z"); // 16:00 CET
    expect(isCadenceDue(baseCadence, muchLater, null)).toBe(true);
  });

  it("is not due on a day that is not enabled", () => {
    const thursday = new Date("2026-04-30T08:05:00Z"); // Thu = 4
    expect(isCadenceDue(baseCadence, thursday, null)).toBe(false);
  });

  it("is not due again once it has published today", () => {
    // Idempotency. Without this a cron running more than once a day would drain
    // the entire queue in one day.
    const today = cadenceLocalDate(baseCadence.timezone, wednesday1005CET);
    expect(isCadenceDue(baseCadence, wednesday1005CET, today)).toBe(false);
  });

  it("is due again the next enabled day", () => {
    const wednesdayDate = cadenceLocalDate(baseCadence.timezone, wednesday1005CET);
    const friday = new Date("2026-05-01T08:05:00Z"); // Fri = 5, enabled
    expect(isCadenceDue(baseCadence, friday, wednesdayDate)).toBe(true);
  });

  it("respects the cadence timezone rather than the server's", () => {
    // 15:05 UTC is 11:05 in New York, past a 10:00 New York publish_time.
    const nyCadence = { ...baseCadence, timezone: "America/New_York" };
    const nyTime = new Date("2026-04-29T15:05:00Z");
    expect(isCadenceDue(nyCadence, nyTime, null)).toBe(true);

    // The same instant is 17:05 in Rome, also past 10:00, but the local DATE
    // used for the already-published check must come from the cadence's zone.
    expect(cadenceLocalDate("America/New_York", nyTime)).toBe("2026-04-29");
  });

  it("handles a Sunday cadence, where day index is 0", () => {
    const sundayCadence = { ...baseCadence, days_of_week: [0] };
    const sunday = new Date("2026-05-03T08:05:00Z");
    expect(isCadenceDue(sundayCadence, sunday, null)).toBe(true);
  });

  it("is never due with no enabled days", () => {
    const noDays = { ...baseCadence, days_of_week: [] };
    expect(isCadenceDue(noDays, wednesday1005CET, null)).toBe(false);
  });

  it("treats midnight publish_time as due all day", () => {
    // Guards the hour12:false / hour "24" quirk in some ICU builds.
    const midnight = { ...baseCadence, publish_time: "00:00" };
    const justAfter = new Date("2026-04-28T22:30:00Z"); // 00:30 CET Wednesday
    expect(isCadenceDue(midnight, justAfter, null)).toBe(true);
  });
});

describe("cadenceDueState", () => {
  const wednesday1005CET = new Date("2026-04-29T08:05:00Z");
  const cadence = { timezone: "Europe/Rome", days_of_week: [1, 3, 5], publish_time: "10:00" };

  it("names why a cadence is skipped, so an empty run is not mistaken for no cadences", () => {
    expect(cadenceDueState(cadence, new Date("2026-04-30T08:05:00Z"), null)).toEqual({ due: false, reason: "not a publishing day" });
    expect(cadenceDueState(cadence, new Date("2026-04-29T07:00:00Z"), null)).toEqual({ due: false, reason: "before publish time" });
    const today = cadenceLocalDate(cadence.timezone, wednesday1005CET);
    expect(cadenceDueState(cadence, wednesday1005CET, today)).toEqual({ due: false, reason: "already published today" });
    expect(cadenceDueState(cadence, wednesday1005CET, null)).toEqual({ due: true, reason: null });
  });
  it("is the single source isCadenceDue reads from", () => {
    expect(isCadenceDue(cadence, wednesday1005CET, null)).toBe(cadenceDueState(cadence, wednesday1005CET, null).due);
  });
});

describe("cadenceLocalDate", () => {
  it("returns the local calendar date, not the UTC one", () => {
    // 23:30 UTC on the 29th is already 01:30 on the 30th in Rome.
    const lateUtc = new Date("2026-04-29T23:30:00Z");
    expect(cadenceLocalDate("Europe/Rome", lateUtc)).toBe("2026-04-30");
    expect(cadenceLocalDate("UTC", lateUtc)).toBe("2026-04-29");
  });
});

describe("withoutPaused", () => {
  it("drops rows whose workspace is paused and keeps the rest in order", () => {
    const rows = [
      { id: "a", workspace_id: "w1" },
      { id: "b", workspace_id: "w2" },
      { id: "c", workspace_id: "w1" },
    ];
    expect(withoutPaused(rows, new Set(["w1"])).map((r) => r.id)).toEqual(["b"]);
  });
  it("changes nothing when nothing is paused", () => {
    const rows = [{ id: "a", workspace_id: "w1" }];
    expect(withoutPaused(rows, new Set())).toEqual(rows);
  });
});
