import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { entitledToScheduledWork, type Quota } from "../quota";

const q = (reason: Quota["reason"], over: Partial<Quota> = {}): Quota => ({
  limit: null, used: 0, remaining: null, reason, plan: null, ...over,
});

describe("entitledToScheduledWork", () => {
  it("refuses only the account with no plan", () => {
    expect(entitledToScheduledWork(q("no-plan", { limit: 1, remaining: 1 }))).toBe(false);
  });

  it("always runs on a self-hosted install", () => {
    // That install pays its own provider bills. Gating it would break the
    // open-source promise, and there is no plan there to check.
    expect(entitledToScheduledWork(q("self-host"))).toBe(true);
  });

  it("runs for a paying account and for an operator", () => {
    expect(entitledToScheduledWork(q("plan", { limit: 100, remaining: 40, plan: "starter" }))).toBe(true);
    expect(entitledToScheduledWork(q("operator"))).toBe(true);
  });

  it("keeps running for a paying account that is out of articles", () => {
    // Out of quota stops NEW drafts, not the tracking of what already shipped.
    // Their published articles must keep being measured.
    expect(entitledToScheduledWork(q("plan", { limit: 100, used: 100, remaining: 0, plan: "starter" }))).toBe(true);
  });

  it("refuses the free account even while its free draft is unused", () => {
    // The draft is free; the standing subscription to DataForSEO is not.
    expect(entitledToScheduledWork(q("no-plan", { limit: 1, used: 0, remaining: 1 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Which crons have to ask, derived rather than listed
// ---------------------------------------------------------------------------
//
// This used to be `it.each(["serp", "geo", "reports"])`: three names typed by
// hand, which checks that three routes still have a gate and says nothing at
// all about the eighth cron somebody adds. `refresh` was that cron. It pays
// Anthropic for a rewrite brief before anything checks a plan, it had never
// had a gate, and this file - the one named for the rule - stayed green for
// as long as it existed. The list was the bug behind the bug.
//
// So the paid set is computed: a route is paid when it can reach a call that
// records provider spend, following its own `@/…` imports. Every paid route
// then either gates on `entitledToScheduledWork` or appears in UNGATED with a
// written reason, and a route in neither state fails with instructions. Same
// shape as lib/plan/__tests__/cron-pause-guard.
//
// `recordSpend`/`setSpendReporter` is the right signal because it is not
// optional: a provider call nobody records is a bill nobody can attribute, and
// lib/billing/spend.ts exists to stop that.

const APP_DIR = join(__dirname, "..", "..", "..");
const CRON_DIR = join(APP_DIR, "app", "api", "cron");

/** Paid routes that deliberately run without the gate, and why. */
const UNGATED: Record<string, string> = {
  analyze:
    "the free front-door audit: `first_analysed_at` bounds it to once per workspace " +
    "for the life of the workspace, and PLAN_WORKSPACE_LIMITS caps a no-plan agency " +
    "at one workspace, so this is one first look per account and cannot repeat",
  generate:
    "the free tier IS drafts: getQuota grants a no-plan agency FREE_DRAFTS a month and " +
    "generateArticle refuses past it, so the gate here would be a second, stricter " +
    "rule contradicting the published free tier",
  "serp-collect":
    "reads answers to tasks cron/serp already posted and paid for; the entitlement " +
    "decision was made at post time, and skipping the collection would bin work " +
    "already bought",
  "site-pages":
    "free by construction - plain GETs. The one paid path (the JS render at " +
    "site-crawl.ts `renderFallback`) has no caller that sets it",
};

/** The gate must stay reachable from the route's own source. */
const GATE = "entitledToScheduledWork(";

function routes(): string[] {
  return readdirSync(CRON_DIR).filter((d) => existsSync(join(CRON_DIR, d, "route.ts")));
}

function resolveImport(spec: string): string | null {
  if (!spec.startsWith("@/")) return null;
  const base = join(APP_DIR, spec.slice(2));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** A call that writes a provider_spend row, i.e. money left the account. */
const SPENDS = /\brecordSpend\s*\(|\bsetSpendReporter\s*\(/;
const SPEND_MODULE = join(APP_DIR, "lib", "billing", "spend.ts");

/**
 * The file, reachable from this route, that spends money - or null. Depth is
 * bounded because the import graph is not a tree; the visited set does the
 * real work and the limit only keeps a pathological graph from being slow.
 */
function spendSite(file: string, seen = new Set<string>(), depth = 0): string | null {
  if (depth > 6 || seen.has(file)) return null;
  seen.add(file);
  const src = readFileSync(file, "utf8");
  // spend.ts declares recordSpend; declaring it is not spending.
  if (file !== SPEND_MODULE && SPENDS.test(src)) return file;
  for (const m of src.matchAll(/from\s+"(@\/[^"]+)"/g)) {
    const resolved = resolveImport(m[1]);
    if (!resolved) continue;
    const hit = spendSite(resolved, seen, depth + 1);
    if (hit) return hit;
  }
  return null;
}

describe("the paid crons gate on entitledToScheduledWork", () => {
  const paid = routes()
    .map((route) => ({ route, site: spendSite(join(CRON_DIR, route, "route.ts")) }))
    .filter((r): r is { route: string; site: string } => r.site !== null);

  it("still finds the paid crons at all", () => {
    // Without this the whole suite below passes vacuously the day the import
    // walk or the spend signal stops matching anything.
    const found = paid.map((p) => p.route);
    for (const known of ["serp", "geo", "refresh", "analyze", "generate"]) {
      expect(found, `${known} spends provider money and must be detected`).toContain(known);
    }
  });

  it("every cron that can spend provider money asks first", () => {
    const missing = paid
      .filter(({ route }) => !(route in UNGATED))
      .filter(({ route }) => !readFileSync(join(CRON_DIR, route, "route.ts"), "utf8").includes(GATE));

    expect(
      missing.map((m) => m.route),
      missing.length === 0
        ? ""
        : `\nThese crons can spend provider money with no plan check:\n` +
            missing.map((m) => `  app/api/cron/${m.route}/route.ts  (spends at ${m.site.replace(APP_DIR, "")})`).join("\n") +
            `\n\nCall entitledToScheduledWork(await getQuota(supabase, agencyId, null)) per\n` +
            `workspace before buying anything - as app/api/cron/serp/route.ts does - or\n` +
            `list the route in UNGATED with the reason it is free.\n`,
    ).toEqual([]);
  });

  it("no route is exempted for a reason that no longer matches its code", () => {
    // Stops UNGATED becoming a graveyard. A route that grew the gate belongs
    // out of the list; a route that stopped spending belongs out of it too.
    const stale = Object.keys(UNGATED).filter((route) => {
      const file = join(CRON_DIR, route, "route.ts");
      if (!existsSync(file)) return true;
      return readFileSync(file, "utf8").includes(GATE) || !paid.some((p) => p.route === route);
    });
    expect(
      stale,
      stale.length === 0 ? "" : `\nThese UNGATED entries no longer describe their route: ${stale.join(", ")}\n`,
    ).toEqual([]);
  });

  it("refresh gates before it buys the rewrite brief", () => {
    // The specific regression: lib/refresh/rewrite.ts writes a paid Anthropic
    // brief inside runRefreshTask, and the only quota check downstream of it
    // is generateArticle's - after the money is gone. The gate has to come
    // first in the file as well as first in the loop.
    const src = readFileSync(join(CRON_DIR, "refresh", "route.ts"), "utf8");
    expect(src).toContain(GATE);
    expect(src.indexOf(GATE)).toBeLessThan(src.indexOf("runRefreshTask(supabase"));
  });
});
