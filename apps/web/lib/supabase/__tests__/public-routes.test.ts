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
// which owns the layout that fetches the user. A page directory sitting
// *directly* under `app/` is there precisely because it has no session to
// belong to. Those are the public ones, and every one of them must be listed.
//
// The consequence is the point: the next sessionless page cannot be added
// without either appearing in PUBLIC_PREFIXES or failing here.

import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { PUBLIC_PREFIXES, isPublicPath } from "../middleware";

const APP_DIR = path.resolve(__dirname, "../../../app");

const IS_ROUTE_FILE = /^(page|route)\.(tsx|ts|jsx|js)$/;

/** Whether this directory, or anything under it, serves a URL. */
function servesSomething(dir: string): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && IS_ROUTE_FILE.test(e.name)) return true;
    if (e.isDirectory() && servesSomething(path.join(dir, e.name))) return true;
  }
  return false;
}

/**
 * Every top-level route segment under `app/` that serves a URL: not a route
 * group `(…)`, not a private folder `_…`, not a dynamic segment, and not `api`
 * (route handlers, already covered wholesale by the `/api` prefix).
 *
 * Recursive, because the page is not always at the top: /check and /share put
 * theirs under a dynamic child (`check/[domain]/page.tsx`).
 */
function sessionlessPageSegments(): string[] {
  return readdirSync(APP_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith("(") && !name.startsWith("_") && !name.startsWith("[") && name !== "api")
    .filter((name) => servesSomething(path.join(APP_DIR, name)))
    .sort();
}

describe("PUBLIC_PREFIXES covers every sessionless page", () => {
  /** If this ever finds nothing, the convention moved and the test below is vacuous. */
  it("finds the sessionless pages on disk", () => {
    const found = sessionlessPageSegments();
    expect(found.length).toBeGreaterThan(0);
    // The four that exist today. Named so a deletion is deliberate, not silent.
    expect(found).toEqual(expect.arrayContaining(["check", "hold", "share", "unsubscribe"]));
  });

  it.each(sessionlessPageSegments())("app/%s is public", (segment) => {
    expect(PUBLIC_PREFIXES).toContain(`/${segment}`);
    expect(isPublicPath(`/${segment}`)).toBe(true);
    expect(isPublicPath(`/${segment}?a=1`.split("?")[0]!)).toBe(true);
  });

  /**
   * The specific regression: a signed hold link must be served, not bounced,
   * because the bounce both defeats the hold and carries the HMAC into the
   * sign-in URL.
   */
  it("serves a signed hold link with no session", () => {
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
   * Nothing may be listed that no route serves. A prefix that matches nothing
   * is dead weight today and a hole the day somebody adds that route back
   * without noticing it was already waved through.
   */
  it("lists no prefix without a route behind it", () => {
    const segments = new Set<string>();
    const collect = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        segments.add(e.name);
        // Route groups and /api are URL-transparent, so their children are
        // segments too: /callback lives at app/(auth)/callback.
        if (e.name.startsWith("(") || e.name === "api") collect(path.join(dir, e.name));
      }
    };
    collect(APP_DIR);
    for (const prefix of PUBLIC_PREFIXES) {
      expect(segments, `${prefix} is listed public but no route serves it`).toContain(prefix.slice(1));
    }
  });
});
