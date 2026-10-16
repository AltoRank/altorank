import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vercel from "@/vercel.json";
import { SCHEDULED_JOBS } from "../scheduled-jobs";
import { jobForSpend } from "../forecast";

const APP_DIR = join(__dirname, "..", "..", "..");

/** The name a cron route files its runs under (observedCron's first argument), or null when it is not wrapped. */
function cronSource(path: string): string | null {
  const file = join(APP_DIR, "app", path, "route.ts");
  if (!existsSync(file)) return null;
  return /observedCron\(\s*"([^"]+)"/.exec(readFileSync(file, "utf8"))?.[1] ?? null;
}

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

  // observedCron labels every spend row a run writes with the cron's own
  // name (provider_spend.job), and jobForSpend files the row by that label.
  // A label the map does not know drops the row from the schedule's Actual:
  // cron.serp_collect was spelled with the path's hyphen and its collection
  // calls were filed under nothing.
  it("files each cron's own spend under the job the schedule shows it in", () => {
    const wrong: string[] = [];
    for (const { path } of vercel.crons) {
      const source = cronSource(path);
      if (!source) continue;
      // serp-collect has no row of its own: its calls are counted under serp.
      const expected = path === "/api/cron/serp-collect" ? "serp" : SCHEDULED_JOBS[path]?.key ?? null;
      const filed = jobForSpend({ provider: "dataforseo", operation: "/serp/google/organic/task_get/regular", job: source });
      if (filed !== expected) wrong.push(`${path} (${source}): ${filed} instead of ${expected}`);
    }
    expect(wrong).toEqual([]);
  });

  it("reads the label of every cron that writes spend", () => {
    for (const path of ["/api/cron/analyze", "/api/cron/serp", "/api/cron/serp-collect", "/api/cron/generate", "/api/cron/geo", "/api/cron/refresh"]) {
      expect(cronSource(path), path).not.toBeNull();
    }
  });
});
