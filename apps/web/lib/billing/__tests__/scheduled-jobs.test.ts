import { describe, expect, it } from "vitest";
import vercel from "@/vercel.json";
import { SCHEDULED_JOBS } from "../scheduled-jobs";

// The Operations schedule reads its times from vercel.json and everything
// else from SCHEDULED_JOBS. A cron missing from the map showed its raw path
// and a dash for cost, which on that table reads as "spent nothing".

describe("SCHEDULED_JOBS", () => {
  it("describes every cron vercel.json runs", () => {
    const missing = vercel.crons.map((c) => c.path).filter((path) => !(path in SCHEDULED_JOBS));
    expect(missing).toEqual([]);
  });

  it("names no cron vercel.json does not run", () => {
    const run = new Set(vercel.crons.map((c) => c.path));
    expect(Object.keys(SCHEDULED_JOBS).filter((path) => !run.has(path))).toEqual([]);
  });

  it("files the refresh rewrites under a job of their own", () => {
    expect(SCHEDULED_JOBS["/api/cron/refresh"].key).toBe("refresh");
  });
});
