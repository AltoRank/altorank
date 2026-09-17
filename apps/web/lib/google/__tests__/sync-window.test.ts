// ---------------------------------------------------------------------------
// The nightly sync must reach past Search Console's publishing lag
// ---------------------------------------------------------------------------
//
// The cron asked for exactly yesterday, once. Search Console publishes a day
// two to three days late, so the answer was empty, the run logged success, and
// the day was never requested again. Production's GSC series stopped on
// 2026-08-31 with a clean `info` row every night after. This pins the window.

import { describe, it, expect } from "vitest";
import { SYNC_LAG_DAYS, syncDates } from "../sync";

describe("syncDates", () => {
  const now = new Date("2026-09-17T04:00:00Z"); // the 04:00 UTC schedule

  it("asks for yesterday back through the publishing lag, newest first", () => {
    expect(syncDates(now)).toEqual(["2026-09-16", "2026-09-15", "2026-09-14"]);
  });

  it("covers the lag with a day to spare", () => {
    // Two days is the lag Google documents; a third absorbs a late day
    // without a missed night turning into a permanent hole.
    expect(SYNC_LAG_DAYS).toBeGreaterThanOrEqual(3);
  });

  it("never includes today", () => {
    expect(syncDates(now)).not.toContain("2026-09-17");
  });

  it("uses UTC dates, so a run just after midnight does not skip a day", () => {
    expect(syncDates(new Date("2026-10-01T00:10:00Z"), 2)).toEqual(["2026-09-30", "2026-09-29"]);
  });
});
