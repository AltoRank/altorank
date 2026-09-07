// ---------------------------------------------------------------------------
// The public list and the filesystem must agree
// ---------------------------------------------------------------------------
//
// `/hold` shipped to production bounced to `/signin`. The page was written to
// be public and sessionless - it is the escape hatch from an automatic publish,
// clicked from an email on a phone - but nobody added it to PUBLIC_PREFIXES, so
// every reader who pressed "Hold this one" got a password field and the article
// published on schedule. Nothing failed; a one-line omission just quietly
// turned the approval gate off by email.
//
// A test naming the routes by hand would have had the same gap, because it
// would have been written from the same list. So this reads the filesystem
// instead, and leans on a convention the app already follows: a page that needs
// a session lives inside a route group - `(dashboard)`, `(setup)`, `(auth)` -
// which owns the layout that fetches the user. A page sitting *outside* every
// route group is there precisely because it has no session to belong to. Those
// are the public ones, and every one of them must be served.
//
// The consequence is the point: the next sessionless page cannot be added
// without either being covered by PUBLIC_PREFIXES or failing here.

import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { PUBLIC_PREFIXES, isPublicPath } from "../middleware";

const APP_DIR = path.resolve(__dirname, "../../../app");

const IS_ROUTE_FILE = /^(page|route)\.(tsx|ts|jsx|js)$/;

/**
 * The URL paths served from one directory downwards.
 *
 * Truncated at the first dynamic segment, because that is where the static part
 * of the URL stops and the part PUBLIC_PREFIXES can talk about ends: `/check`
 * is what has to be public for `check/[domain]/page.tsx` to be reachable.
 */
function urlPathsUnder(dir: string, prefix: string, out: Set<string>): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && IS_ROUTE_FILE.test(e.name)) out.add(prefix);
    if (!e.isDirectory()) continue;
    // Private folders and parallel routes serve no URL of their own.
    if (e.name.startsWith("_") || e.name.startsWith("@")) continue;
    // A dynamic segment: everything below it hangs off the prefix so far.
    if (e.name.startsWith("[")) {
      out.add(prefix);
      continue;
    }
    urlPathsUnder(path.join(dir, e.name), `${prefix}/${e.name}`, out);
  }
}

/**
 * Every URL served by a page outside every route group - the sessionless ones.
 *
 * `api` is excluded: route handlers authenticate per request (bearer token,
 * signed cron secret, Stripe signature) rather than by session, and the `/api`
 * prefix already waves the whole tree through.
 */
function sessionlessRoutePaths(): string[] {
  const out = new Set<string>();
  for (const e of readdirSync(APP_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const { name } = e;
    if (name.startsWith("(") || name.startsWith("_") || name.startsWith("[") || name === "api") continue;
    urlPathsUnder(path.join(APP_DIR, name), `/${name}`, out);
  }
  return [...out].sort();
}

describe("PUBLIC_PREFIXES covers every sessionless page", () => {
  /** If this ever finds nothing, the convention moved and the test below is vacuous. */
  it("finds the sessionless pages on disk", () => {
    const found = sessionlessRoutePaths();
    expect(found.length).toBeGreaterThan(0);
    // The ones that exist today. Named so a deletion is deliberate, not silent.
    expect(found).toEqual(
      expect.arrayContaining(["/check", "/hold", "/share", "/unsubscribe", "/oauth/authorize"]),
    );
  });

  it.each(sessionlessRoutePaths())("%s is served without a session", (routePath) => {
    expect(isPublicPath(routePath)).toBe(true);
  });

  /**
   * The specific regression: a signed hold link must be served, not bounced,
   * because the bounce both defeats the hold and carries the HMAC into the
   * sign-in URL.
   */
  it("serves a signed hold link with no session", () => {
    expect(PUBLIC_PREFIXES).toContain("/hold");
    expect(isPublicPath("/hold")).toBe(true);
  });

  /** Deny-by-default still holds for everything in a route group. */
  it.each(["/dashboard", "/articles", "/content/abc", "/settings/billing", "/onboarding", "/geo", "/audits"])(
    "%s stays private",
    (p) => {
      expect(isPublicPath(p)).toBe(false);
    },
  );

  /** A prefix must not leak its neighbours: /holding is not /hold. */
  it("matches whole segments, not string prefixes", () => {
    expect(isPublicPath("/holdings")).toBe(false);
    expect(isPublicPath("/shared-secrets")).toBe(false);
    expect(isPublicPath("/hold/anything")).toBe(true);
  });

  /**
   * A narrower prefix must not widen itself. `/oauth/authorize` is listed, and
   * deliberately not `/oauth`: the consent screen is public because it handles
   * the signed-out case itself, which says nothing about whatever else lands
   * under /oauth later.
   */
  it("keeps /oauth/authorize from making the rest of /oauth public", () => {
    expect(isPublicPath("/oauth/authorize")).toBe(true);
    expect(isPublicPath("/oauth")).toBe(false);
    expect(isPublicPath("/oauth/tokens")).toBe(false);
  });

  /**
   * Nothing may be listed that no route serves. A prefix that matches nothing
   * is dead weight today and a hole the day somebody adds that route back
   * without noticing it was already waved through.
   *
   * Deliberately loose about *where* the directory lives: route groups and
   * `api` are walked through, so `/callback` is satisfied by
   * `app/(auth)/callback` and `/auth` by `app/api/auth`. This is a check that
   * a name is not invented, not a check that the URL resolves.
   */
  it("lists no prefix without a route behind it", () => {
    const hasSegments = (dir: string, segments: readonly string[]): boolean => {
      if (segments.length === 0) return true;
      const [head, ...rest] = segments;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const child = path.join(dir, e.name);
        if (e.name === head && hasSegments(child, rest)) return true;
        // Route groups and /api are walked through, not matched against.
        if ((e.name.startsWith("(") || e.name === "api") && hasSegments(child, segments)) return true;
      }
      return false;
    };

    for (const prefix of PUBLIC_PREFIXES) {
      const segments = prefix.slice(1).split("/");
      expect(hasSegments(APP_DIR, segments), `${prefix} is listed public but no route serves it`).toBe(true);
    }
  });
});
