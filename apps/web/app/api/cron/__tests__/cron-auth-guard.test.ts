import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every cron route authorises through lib/cron-auth's isAuthorizedCron():
 * constant-time comparison, both header shapes, fail-closed on an unset
 * secret. Until 2026-09-07 eleven routes compared the secret with `!==`
 * inline while the helper sat unused beside them (T7). This reads the
 * sources so the pattern cannot creep back one route at a time.
 */
const CRON = join(__dirname, "..");
const routes = readdirSync(CRON)
  .filter((d) => statSync(join(CRON, d)).isDirectory() && d !== "__tests__")
  .map((d) => ({ name: d, src: readFileSync(join(CRON, d, "route.ts"), "utf8") }));

describe("cron routes authorise through isAuthorizedCron", () => {
  it("finds the routes", () => {
    expect(routes.length).toBeGreaterThan(5);
  });
  for (const { name, src } of routes) {
    it(`${name} calls isAuthorizedCron and never compares CRON_SECRET itself`, () => {
      expect(src).toContain("isAuthorizedCron(request)");
      expect(src).not.toMatch(/!==\s*process\.env\.CRON_SECRET/);
      expect(src).not.toMatch(/process\.env\.CRON_SECRET\s*!==/);
    });
  }
});

/**
 * Same shape for the per-IP limiters: `x-forwarded-for[0]` is whatever the
 * client wrote, so a limiter keyed on it is a formality. lib/tools/client-ip
 * reads the hop our own edge set; nothing outside it parses the header.
 */
describe("per-IP limiters read the address through lib/tools/client-ip", () => {
  const roots = [join(__dirname, "..", "..", "..", "actions"), join(__dirname, "..", "..", "..", "..", "lib")];
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry !== "__tests__" && entry !== "node_modules") walk(p, out);
      } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(p);
    }
    return out;
  }
  it("nothing but client-ip.ts parses x-forwarded-for", () => {
    const offenders = roots
      .flatMap((r) => walk(r))
      .filter((p) => !p.endsWith(join("tools", "client-ip.ts")))
      .filter((p) => readFileSync(p, "utf8").includes("x-forwarded-for"));
    expect(offenders).toEqual([]);
  });
});
