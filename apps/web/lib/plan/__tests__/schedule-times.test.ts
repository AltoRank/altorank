import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cronUtcTime, cronTimeFor, scheduleSentence, SCHEDULE_TIMES } from "../schedule-times";

describe("schedule times", () => {
  it("reads a single daily cron as a UTC wall-clock time", () => {
    expect(cronUtcTime("0 9 * * *")).toBe("09:00");
    expect(cronUtcTime("20 3 * * *")).toBe("03:20");
  });
  it("has no sentence for lists, steps or nonsense", () => {
    expect(cronUtcTime("0 1,7,13,19 * * *")).toBeNull();
    expect(cronUtcTime("*/15 * * * *")).toBeNull();
    expect(cronUtcTime("0 25 * * *")).toBeNull();
  });
  it("finds a job by path and is null for a missing one", () => {
    const crons = [{ path: "/api/cron/publish", schedule: "0 9 * * *" }];
    expect(cronTimeFor(crons, "/api/cron/publish")).toBe("09:00");
    expect(cronTimeFor(crons, "/api/cron/nothing")).toBeNull();
  });
  it("quotes vercel.json rather than a number typed here", () => {
    const vercel = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "vercel.json"), "utf8")) as {
      crons: { path: string; schedule: string }[];
    };
    expect(SCHEDULE_TIMES.generate).toBe(cronTimeFor(vercel.crons, "/api/cron/generate"));
    expect(SCHEDULE_TIMES.publish).toBe(cronTimeFor(vercel.crons, "/api/cron/publish"));
    expect(SCHEDULE_TIMES.generate).not.toBeNull();
    expect(SCHEDULE_TIMES.publish).not.toBeNull();
  });
  it("says so plainly, and falls back to the fact when a time is unknown", () => {
    expect(scheduleSentence({ generate: "07:00", publish: "09:00" })).toBe(
      "Articles are generated around 07:00 UTC and land in Review; approved articles publish on your chosen days within the hour after your publish time.",
    );
    expect(scheduleSentence({ generate: null, publish: null })).toBe(
      "Articles are generated each morning UTC and land in Review; approved articles publish on your chosen days within the hour after your publish time.",
    );
  });
});
