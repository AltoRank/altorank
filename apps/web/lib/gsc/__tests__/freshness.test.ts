import { describe, expect, it } from "vitest";
import { analyticsCronSchedule, nextCronRun, nextSyncClock, relativeTime, utcClock } from "../freshness";

describe("analyticsCronSchedule", () => {
  it("reads the analytics cron out of vercel.json rather than repeating it", () => {
    // Whatever the file says, as long as it is a daily expression we can read.
    const schedule = analyticsCronSchedule();
    expect(schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    expect(nextSyncClock(new Date("2026-09-04T10:00:00Z"))).toMatch(/^\d\d:\d\d UTC$/);
  });
});

describe("nextCronRun", () => {
  it("returns today's run when it is still ahead, tomorrow's when it has passed", () => {
    expect(nextCronRun("0 4 * * *", new Date("2026-09-04T01:00:00Z"))?.toISOString()).toBe("2026-09-04T04:00:00.000Z");
    expect(nextCronRun("0 4 * * *", new Date("2026-09-04T04:00:00Z"))?.toISOString()).toBe("2026-09-05T04:00:00.000Z");
    expect(nextCronRun("30 23 * * *", new Date("2026-09-04T23:31:00Z"))?.toISOString()).toBe("2026-09-05T23:30:00.000Z");
  });
  it("refuses shapes it does not understand instead of guessing", () => {
    expect(nextCronRun("*/15 * * * *", new Date())).toBeNull();
    expect(nextCronRun("0 6 1 * *", new Date())).toBeNull();
    expect(nextCronRun("0 25 * * *", new Date())).toBeNull();
    expect(nextCronRun(null, new Date())).toBeNull();
  });
  it("formats as a UTC clock", () => {
    expect(utcClock(new Date("2026-09-05T04:00:00Z"))).toBe("04:00 UTC");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  it("says never for nothing, and nothing else", () => {
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime(undefined, now)).toBe("never");
    expect(relativeTime("not a date", now)).toBe("never");
  });
  it("is coarse and singular where it should be", () => {
    expect(relativeTime("2026-09-04T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-09-04T11:59:00Z", now)).toBe("1 minute ago");
    expect(relativeTime("2026-09-04T11:18:00Z", now)).toBe("42 minutes ago");
    expect(relativeTime("2026-09-04T09:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-09-02T11:00:00Z", now)).toBe("2 days ago");
  });
});
