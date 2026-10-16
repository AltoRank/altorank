import { describe, it, expect } from "vitest";
import { isCadenceDue, cadenceDueState, cadenceLocalDate, withoutPaused, cadenceSlots, shipLabel } from "../cadence";
import { shipDateFor, shipLabelFor } from "../ship-date";

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

describe("cadenceSlots", () => {
  // Mon, Wed, Fri at 10:00 in Rome. 2026-10-21 is a Wednesday.
  const cadence = { timezone: "Europe/Rome", days_of_week: [1, 3, 5], publish_time: "10:00" };
  const iso = (d: Date[]) => d.map((x) => x.toISOString());

  it("starts with today's slot before publish_time", () => {
    const now = new Date("2026-10-21T06:00:00Z"); // Wed 08:00 Rome
    expect(iso(cadenceSlots(cadence, now, null, 3))).toEqual([
      "2026-10-21T08:00:00.000Z", // Wed 10:00
      "2026-10-23T08:00:00.000Z", // Fri 10:00
      "2026-10-26T09:00:00.000Z", // Mon 10:00, after the clocks went back
    ]);
  });

  it("keeps today's slot after publish_time when nothing went out yet: the next run takes it", () => {
    const now = new Date("2026-10-21T12:00:00Z"); // Wed 14:00 Rome
    expect(iso(cadenceSlots(cadence, now, null, 1))).toEqual(["2026-10-21T08:00:00.000Z"]);
  });

  it("skips today once the site has published today", () => {
    const now = new Date("2026-10-21T06:00:00Z");
    expect(iso(cadenceSlots(cadence, now, "2026-10-21", 1))).toEqual(["2026-10-23T08:00:00.000Z"]);
  });

  it("skips days that are not publishing days", () => {
    const now = new Date("2026-10-22T06:00:00Z"); // Thu
    expect(iso(cadenceSlots(cadence, now, null, 1))).toEqual(["2026-10-23T08:00:00.000Z"]);
  });

  it("reads a publish_time with seconds, as Postgres returns a time column", () => {
    const now = new Date("2026-10-21T06:00:00Z");
    expect(iso(cadenceSlots({ ...cadence, publish_time: "10:30:00" }, now, null, 1))).toEqual(["2026-10-21T08:30:00.000Z"]);
  });

  it("returns nothing for a cadence with no days", () => {
    expect(cadenceSlots({ ...cadence, days_of_week: [] }, new Date(), null, 2)).toEqual([]);
  });
});

describe("shipLabel", () => {
  const tz = "Europe/Rome";
  const now = new Date("2026-10-21T06:00:00Z"); // Wed 08:00 Rome

  it("names today, tomorrow, a weekday, then a date", () => {
    expect(shipLabel(new Date("2026-10-21T08:00:00Z"), tz, now)).toBe("today 10:00");
    expect(shipLabel(new Date("2026-10-22T08:00:00Z"), tz, now)).toBe("tomorrow 10:00");
    expect(shipLabel(new Date("2026-10-23T08:00:00Z"), tz, now)).toBe("Fri 10:00");
    expect(shipLabel(new Date("2026-10-28T09:00:00Z"), tz, now)).toBe("Wed 28 Oct 10:00");
  });

  it("says today, with no time, for a slot already due", () => {
    expect(shipLabel(new Date("2026-10-21T05:00:00Z"), tz, now)).toBe("today");
  });

  it("reads the day in the site's timezone, not the server's", () => {
    // 23:30 UTC on Wed is already Thu 08:30 in Tokyo.
    const late = new Date("2026-10-21T23:30:00Z");
    expect(shipLabel(new Date("2026-10-22T01:00:00Z"), "Asia/Tokyo", late)).toBe("today 10:00");
  });
});

describe("shipDateFor", () => {
  // Mon, Wed, Fri at 10:00 in Rome; now is Wed 08:00 Rome, nothing out today.
  const schedule = {
    cadence: { timezone: "Europe/Rome", days_of_week: [1, 3, 5], publish_time: "10:00" },
    queue: [
      { id: "q1", created_at: "2026-10-10T00:00:00Z" },
      { id: "q2", created_at: "2026-10-12T00:00:00Z" },
    ],
    lastLocalDate: null,
    now: new Date("2026-10-21T06:00:00Z"),
  };

  it("gives the queue's oldest article the next slot", () => {
    expect(shipDateFor(schedule, { id: "q1", status: "scheduled", created_at: "2026-10-10T00:00:00Z" })?.toISOString()).toBe("2026-10-21T08:00:00.000Z");
    expect(shipDateFor(schedule, { id: "q2", status: "scheduled", created_at: "2026-10-12T00:00:00Z" })?.toISOString()).toBe("2026-10-23T08:00:00.000Z");
  });

  it("puts a draft in review behind the older queued ones, where phase 2 would take it", () => {
    expect(shipDateFor(schedule, { id: "r", status: "review", created_at: "2026-10-15T00:00:00Z" })?.toISOString()).toBe("2026-10-26T09:00:00.000Z");
    // Older than everything queued: it goes first once approved.
    expect(shipDateFor(schedule, { id: "r", status: "review", created_at: "2026-10-01T00:00:00Z" })?.toISOString()).toBe("2026-10-21T08:00:00.000Z");
  });

  it("uses a picked date as it is, and has nothing for other states", () => {
    expect(shipDateFor(schedule, { id: "s", status: "scheduled", created_at: "2026-10-01T00:00:00Z", scheduled_at: "2026-11-02T08:30:00.000Z" })?.toISOString()).toBe("2026-11-02T08:30:00.000Z");
    expect(shipDateFor(schedule, { id: "a", status: "approved", created_at: "2026-10-01T00:00:00Z" })).toBeNull();
    expect(shipLabelFor(schedule, { id: "q2", status: "scheduled", created_at: "2026-10-12T00:00:00Z" })).toBe("Fri 10:00");
  });
});
