/**
 * A paused site does nothing. Every scheduled job that acts on a workspace
 * has to skip `status = 'paused'`, and nothing but reading the routes can
 * check that: the routes are not callable from vitest and the filter is one
 * chained call that is easy to leave out of a new query.
 *
 * Reads the source like lib/queries/__tests__/workspace-scope-guard does. A
 * new cron under app/api/cron that touches workspaces, articles or cadences
 * has to appear here with the way it skips paused sites.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const CRON_DIR = join(__dirname, "..", "..", "..", "app", "api", "cron");

/** Route -> the text that proves it skips paused workspaces. */
const SKIPS_PAUSED: Record<string, string> = {
  generate: `.neq("status", "paused")`,
  analyze: `.neq("status", "paused")`,
  "site-pages": `.neq("status", "paused")`,
  // Publishing starts from cadences and articles, not workspace rows, so it
  // reads the paused set once and filters both phases through it.
  publish: "withoutPaused(",
};

describe("crons skip paused workspaces", () => {
  for (const [route, proof] of Object.entries(SKIPS_PAUSED)) {
    it(`${route} filters paused sites`, () => {
      const file = join(CRON_DIR, route, "route.ts");
      expect(existsSync(file), `${file} exists`).toBe(true);
      expect(readFileSync(file, "utf8")).toContain(proof);
    });
  }

  it("publish applies the paused set to both phases", () => {
    const src = readFileSync(join(CRON_DIR, "publish", "route.ts"), "utf8");
    expect(src.match(/withoutPaused\(/g)?.length).toBe(2);
  });

  it("every cron that reads workspaces directly says what it does about paused ones", () => {
    // The generate/analyze/site-pages rule: a `.from("workspaces")` read that
    // selects candidates for work must carry the status filter. Routes that
    // only look a workspace up by id (serp, analytics, exchange, geo, reports)
    // are not choosing whom to work for and are not in scope here.
    const routes = readdirSync(CRON_DIR).filter((d) => existsSync(join(CRON_DIR, d, "route.ts")));
    for (const route of routes) {
      if (!(route in SKIPS_PAUSED)) continue;
      const src = readFileSync(join(CRON_DIR, route, "route.ts"), "utf8");
      expect(src.includes("paused"), `${route} mentions paused`).toBe(true);
    }
  });
});
