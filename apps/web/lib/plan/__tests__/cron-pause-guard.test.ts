/**
 * A paused site does nothing. Every scheduled job that acts on a workspace
 * has to skip `status = 'paused'`, and nothing but reading the routes can
 * check that: the routes are not callable from vitest and the filter is one
 * chained call that is easy to leave out of a new query.
 *
 * Reads the source like lib/queries/__tests__/workspace-scope-guard does. A
 * new cron under app/api/cron that selects workspaces to work on has to appear
 * in SKIPS_PAUSED or in NOT_SELECTING, with the reason.
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
  refresh: `.neq("status", "paused")`,
  serp: `.neq("status", "paused")`,
  geo: `.neq("status", "paused")`,
  reports: `.neq("status", "paused")`,
  // Publishing starts from cadences and articles, not workspace rows, so it
  // reads the paused set once and filters both phases through it.
  publish: "withoutPaused(",
};

/**
 * Routes that read `workspaces` without choosing whom to work for, and why.
 *
 * The distinction matters: a job that resolves a workspace it was already
 * handed has nothing to decide, and adding a pause filter there would only
 * hide rows from a lookup. A job that *selects candidates* is choosing to
 * spend money on a client, and that is the decision a pause exists to stop.
 */
const NOT_SELECTING: Record<string, string> = {
  "serp-collect":
    "resolves workspaces by id from the DataForSEO tasks serp already posted; " +
    "the pause decision was made when those tasks were queued",
  analytics:
    "walks workspace_integrations, not workspaces - a paused site's Search Console " +
    "history is still its history, and syncing it costs nothing",
  exchange: "does not read workspaces at all; it expires backlink_exchanges rows",
};

function routes(): string[] {
  return readdirSync(CRON_DIR).filter((d) => existsSync(join(CRON_DIR, d, "route.ts")));
}

function sourceOf(route: string): string {
  return readFileSync(join(CRON_DIR, route, "route.ts"), "utf8");
}

/**
 * A `.from("workspaces")` that picks rows rather than resolving known ones.
 * `.eq("id", …)` / `.in("id", …)` and `.update(...)` chains are lookups and
 * writes against a row the caller already chose.
 */
function selectsWorkspaces(src: string): boolean {
  for (const m of src.matchAll(/\.from\("workspaces"\)/g)) {
    let chain = src.slice(m.index! + m[0].length).split("\n").slice(0, 14).join("\n");
    const next = chain.indexOf(".from(");
    if (next !== -1) chain = chain.slice(0, next);
    if (!/^\s*\.select\(/.test(chain)) continue; // update/insert/delete
    if (/\.(eq|in)\(\s*["']id["']/.test(chain)) continue; // resolved by id
    return true;
  }
  return false;
}

describe("crons skip paused workspaces", () => {
  for (const [route, proof] of Object.entries(SKIPS_PAUSED)) {
    it(`${route} filters paused sites`, () => {
      const file = join(CRON_DIR, route, "route.ts");
      expect(existsSync(file), `${file} exists`).toBe(true);
      expect(readFileSync(file, "utf8")).toContain(proof);
    });
  }

  it("generate lifts the account pause whose date has passed before it picks work", () => {
    // Stripe resumes charging on `paused_until` by itself; this is the
    // write that resumes the work it is charging for (lib/billing/resume.ts).
    const src = sourceOf("generate");
    expect(src).toContain("resumeExpiredPauses(");
    expect(src.indexOf("resumeExpiredPauses(")).toBeLessThan(src.indexOf(`.neq("status", "paused")`));
  });

  it("publish applies the paused set to both phases", () => {
    expect(sourceOf("publish").match(/withoutPaused\(/g)?.length).toBe(2);
  });

  it("every cron that selects workspaces to work on skips the paused ones", () => {
    // The rule the file header states, actually enforced. The previous version
    // of this test skipped any route not already in SKIPS_PAUSED, so it only
    // re-checked the four routes the loop above had checked - which is how
    // serp, geo and reports came to select workspaces with no filter at all
    // while a test named for this rule stayed green.
    const missing = routes().filter(
      (route) =>
        selectsWorkspaces(sourceOf(route)) &&
        !(route in SKIPS_PAUSED) &&
        !(route in NOT_SELECTING),
    );

    expect(
      missing,
      missing.length === 0
        ? ""
        : `\nThese crons select workspaces to work on and say nothing about paused ones:\n` +
            missing.map((r) => `  app/api/cron/${r}/route.ts`).join("\n") +
            `\n\nAdd .neq("status", "paused") to the select and list the route in\n` +
            `SKIPS_PAUSED, or - if it is resolving workspaces it was already handed -\n` +
            `list it in NOT_SELECTING with the reason.\n`,
    ).toEqual([]);
  });

  it("no route is exempted for a reason that no longer matches its code", () => {
    // Stops NOT_SELECTING becoming a graveyard: a route that starts selecting
    // candidates must move to SKIPS_PAUSED rather than keep its exemption.
    const wrong = Object.keys(NOT_SELECTING).filter(
      (route) => existsSync(join(CRON_DIR, route, "route.ts")) && selectsWorkspaces(sourceOf(route)),
    );
    expect(
      wrong,
      wrong.length === 0
        ? ""
        : `\nThese routes are exempted as "not selecting workspaces" but now do:\n` +
            wrong.map((r) => `  app/api/cron/${r}/route.ts`).join("\n") + `\n`,
    ).toEqual([]);
  });
});
